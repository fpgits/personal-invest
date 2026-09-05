import { and, eq, gte, inArray } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { db } from "@/db";
import {
  assets,
  events,
  eventSources,
  insiderTransactions,
  news,
  type Asset,
  type InsiderTransaction,
} from "@/db/schema";
import { EDGAR_LIMITS, ensureCiks, recentFilings, secFetch } from "./edgar";
import { env } from "./env";
import { loadWeights } from "./intel/calibration";
import { portfolioRelevance, scoreSignal } from "./intel/score";
import { trackedContext } from "./managers";
import { id } from "./utils";

/**
 * Insiders (Form 4 de EDGAR): compras y ventas de directivos, consejeros y
 * accionistas >10% con su propio dinero. Es de las senales con mejor
 * evidencia que existen, y es fuente primaria: tier 1, sin IA. Se guarda cada
 * operacion y se agregan por ventana de 30 dias para distinguir una compra
 * agrupada (varios insiders comprando a la vez) de una concesion de acciones
 * o una retencion fiscal, que no dicen nada.
 *
 * Codigos SEC que importan: P = compra en mercado abierto, S = venta. El
 * resto (A concesion, M ejercicio de opciones, F retencion fiscal, G regalo,
 * J otros) se guarda pero no genera senal. Las ventas bajo plan 10b5-1
 * (preprogramadas) se marcan y no cuentan como senal bajista.
 */

export const INSIDER_LIMITS = {
  /** Ventana de agregacion de la senal. */
  windowDays: 30,
  /** Form 4 que se descargan por pasada (1 peticion cada uno). */
  docsPerRun: 25,
  /** Solo se miran filings de este maximo de dias atras. */
  maxAgeDays: 45,
  /** Umbrales en USD. */
  bigBuy: 100_000,
  minBuy: 25_000,
  bigSell: 1_000_000,
  halfPositionSell: 250_000,
} as const;

export const INSIDER_PROMPT_VERSION = "form4-v1";

export const INSIDER_ASSESSMENT =
  "Una compra con dinero propio de quien conoce la empresa por dentro vale mas que cualquier titular; una venta dice menos (liquidez, diversificacion, impuestos). Contrasta con tu tesis y con la valoracion.";

// ---------------------------------------------------------------------------
// Parseo del Form 4 (XML ownershipDocument). Puro y testeable.

export type OwnerRole = "director" | "officer" | "ten_percent" | "other";

export type Form4Transaction = {
  txIndex: number;
  ownerName: string;
  ownerRole: OwnerRole;
  officerTitle: string | null;
  code: string;
  acquired: boolean;
  shares: number;
  price: number | null;
  value: number | null;
  postShares: number | null;
  planned: boolean;
  transactionAt: number;
};

export type Form4 = {
  issuerCik: string;
  issuerName: string;
  symbol: string;
  periodOfReport: string | null;
  transactions: Form4Transaction[];
};

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function val(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return val(o.value);
    return "";
  }
  return String(v).trim();
}

function flag(v: unknown): boolean {
  const s = val(v).toLowerCase();
  return s === "1" || s === "true";
}

function num(v: unknown): number | null {
  const s = val(v).replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseForm4(xml: string): Form4 | null {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const root = (doc.ownershipDocument ?? null) as Record<string, unknown> | null;
  if (!root) return null;

  const issuer = (root.issuer ?? {}) as Record<string, unknown>;
  const symbol = val(issuer.issuerTradingSymbol).toUpperCase();
  const owners = arr(root.reportingOwner as Record<string, unknown> | Record<string, unknown>[]).map((o) => {
    const idObj = (o.reportingOwnerId ?? {}) as Record<string, unknown>;
    const rel = (o.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
    const isOfficer = flag(rel.isOfficer);
    const isDirector = flag(rel.isDirector);
    const isTen = flag(rel.isTenPercentOwner);
    const role: OwnerRole = isOfficer ? "officer" : isDirector ? "director" : isTen ? "ten_percent" : "other";
    return {
      name: val(idObj.rptOwnerName) || "Insider",
      role,
      title: val(rel.officerTitle) || null,
    };
  });
  // Con varios firmantes (p. ej. un fondo y su gestor) se atribuye al primero.
  const owner = owners[0] ?? { name: "Insider", role: "other" as OwnerRole, title: null };
  const planned = flag(root.aff10b5One);

  const table = (root.nonDerivativeTable ?? {}) as Record<string, unknown>;
  const txs = arr(table.nonDerivativeTransaction as Record<string, unknown> | Record<string, unknown>[]);
  const transactions: Form4Transaction[] = [];
  txs.forEach((t, i) => {
    const coding = (t.transactionCoding ?? {}) as Record<string, unknown>;
    const amounts = (t.transactionAmounts ?? {}) as Record<string, unknown>;
    const post = (t.postTransactionAmounts ?? {}) as Record<string, unknown>;
    const code = val(coding.transactionCode).toUpperCase();
    const shares = num(amounts.transactionShares);
    const date = Date.parse(`${val(t.transactionDate)}T12:00:00Z`);
    if (!code || shares === null || !Number.isFinite(date)) return;
    const price = num(amounts.transactionPricePerShare);
    const acquired = val(amounts.transactionAcquiredDisposedCode).toUpperCase() === "A";
    transactions.push({
      txIndex: i,
      ownerName: owner.name,
      ownerRole: owner.role,
      officerTitle: owner.title,
      code,
      acquired,
      shares,
      price,
      value: price !== null ? Math.round(shares * price) : null,
      postShares: num(post.sharesOwnedFollowingTransaction),
      planned,
      transactionAt: date,
    });
  });

  return {
    issuerCik: val(issuer.issuerCik),
    issuerName: val(issuer.issuerName),
    symbol,
    periodOfReport: val(root.periodOfReport) || null,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Senales agregadas por ventana. Puro y testeable.

export type InsiderSignalKind = "cluster_buy" | "big_buy" | "buy" | "big_sell" | "half_position_sell";

export type InsiderSignal = {
  kind: InsiderSignalKind;
  symbol: string;
  headline: string;
  fact: string;
  materiality: number;
  /** Signo: + compra, - venta. */
  thesisImpact: number;
  occurredAt: number;
  /** Filing mas reciente de los que sostienen la senal (clave de dedup). */
  latestAccession: string;
  url: string;
  owners: string[];
  totalValue: number;
};

type TxLike = Pick<
  InsiderTransaction,
  | "symbol"
  | "accession"
  | "ownerName"
  | "ownerRole"
  | "officerTitle"
  | "code"
  | "acquired"
  | "shares"
  | "value"
  | "postShares"
  | "planned"
  | "transactionAt"
  | "filedAt"
  | "url"
>;

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function who(t: TxLike): string {
  const role =
    t.ownerRole === "officer"
      ? t.officerTitle || "directivo"
      : t.ownerRole === "director"
        ? "consejero"
        : t.ownerRole === "ten_percent"
          ? "accionista >10%"
          : "insider";
  return `${t.ownerName} (${role})`;
}

/**
 * A partir de las operaciones de UN activo en la ventana, las senales que
 * merecen evento. Solo se emiten las que se apoyan en un filing nuevo
 * (`newAccessions`): asi cada senal se dispara una vez, cuando llega.
 */
export function insiderSignals(
  txs: TxLike[],
  newAccessions: Set<string>,
  now: number,
  windowDays = INSIDER_LIMITS.windowDays,
): InsiderSignal[] {
  const since = now - windowDays * 86400_000;
  const inWindow = txs.filter((t) => t.transactionAt >= since && t.transactionAt <= now + 86400_000);
  if (inWindow.length === 0) return [];
  const symbol = inWindow[0].symbol.toUpperCase();
  const out: InsiderSignal[] = [];

  // La senal se dispara cuando llega un filing nuevo y se ancla a el (el mas
  // reciente de los nuevos); asi no depende del orden entre filings del mismo dia.
  const latestNew = (list: TxLike[]): TxLike | null => {
    const fresh = list.filter((t) => newAccessions.has(t.accession));
    if (fresh.length === 0) return null;
    return [...fresh].sort((a, b) => b.filedAt - a.filedAt || b.transactionAt - a.transactionAt)[0];
  };

  // Compras en mercado abierto.
  const buys = inWindow.filter((t) => t.code === "P" && t.acquired && (t.value ?? 0) > 0);
  if (buys.length > 0) {
    const owners = [...new Set(buys.map((t) => t.ownerName))];
    const total = buys.reduce((s, t) => s + (t.value ?? 0), 0);
    const last = latestNew(buys);
    if (last) {
      const names = owners.slice(0, 3).map((o) => who(buys.find((b) => b.ownerName === o)!)).join(", ");
      const span = Math.max(1, Math.round((last.transactionAt - Math.min(...buys.map((b) => b.transactionAt))) / 86400_000));
      if (owners.length >= 2) {
        out.push({
          kind: "cluster_buy",
          symbol,
          headline: `Compra agrupada de insiders en ${symbol}: ${owners.length} directivos compran ${money(total)}`,
          fact: `${owners.length} insiders distintos compraron acciones de ${symbol} en mercado abierto por un total de ${money(total)} en ${span} dia(s): ${names}. Fuente: Form 4 (SEC EDGAR).`,
          materiality: 85,
          thesisImpact: 35,
          occurredAt: last.transactionAt,
          latestAccession: last.accession,
          url: last.url,
          owners,
          totalValue: total,
        });
      } else if (total >= INSIDER_LIMITS.bigBuy) {
        out.push({
          kind: "big_buy",
          symbol,
          headline: `${who(last)} compra ${money(total)} de ${symbol} en mercado abierto`,
          fact: `${who(last)} compro ${buys.reduce((s, t) => s + t.shares, 0).toLocaleString("en-US")} acciones de ${symbol} por ${money(total)}${last.postShares !== null ? `; posicion tras la compra: ${Math.round(last.postShares).toLocaleString("en-US")} acciones` : ""}. Fuente: Form 4 (SEC EDGAR).`,
          materiality: 70,
          thesisImpact: 25,
          occurredAt: last.transactionAt,
          latestAccession: last.accession,
          url: last.url,
          owners,
          totalValue: total,
        });
      } else if (total >= INSIDER_LIMITS.minBuy) {
        out.push({
          kind: "buy",
          symbol,
          headline: `${who(last)} compra ${money(total)} de ${symbol}`,
          fact: `${who(last)} compro acciones de ${symbol} en mercado abierto por ${money(total)}. Fuente: Form 4 (SEC EDGAR).`,
          materiality: 50,
          thesisImpact: 15,
          occurredAt: last.transactionAt,
          latestAccession: last.accession,
          url: last.url,
          owners,
          totalValue: total,
        });
      }
    }
  }

  // Ventas discrecionales (no 10b5-1) de directivos y consejeros.
  const sells = inWindow.filter(
    (t) => t.code === "S" && !t.acquired && !t.planned && (t.value ?? 0) > 0 && t.ownerRole !== "other",
  );
  if (sells.length > 0) {
    const last = latestNew(sells);
    if (last) {
      const owners = [...new Set(sells.map((t) => t.ownerName))];
      const total = sells.reduce((s, t) => s + (t.value ?? 0), 0);
      // Alguien vende mas de la mitad de lo que tenia.
      const half = sells.find(
        (t) => t.postShares !== null && t.shares / (t.shares + t.postShares) >= 0.5 && (t.value ?? 0) >= INSIDER_LIMITS.halfPositionSell,
      );
      if (half) {
        const pct = Math.round((half.shares / (half.shares + (half.postShares ?? 0))) * 100);
        out.push({
          kind: "half_position_sell",
          symbol,
          headline: `${who(half)} vende el ${pct}% de su posicion en ${symbol} (${money(half.value ?? 0)})`,
          fact: `${who(half)} vendio ${Math.round(half.shares).toLocaleString("en-US")} acciones de ${symbol} por ${money(half.value ?? 0)}, el ${pct}% de lo que tenia; le quedan ${Math.round(half.postShares ?? 0).toLocaleString("en-US")}. Venta discrecional (no bajo plan 10b5-1). Fuente: Form 4 (SEC EDGAR).`,
          materiality: 65,
          thesisImpact: -20,
          occurredAt: half.transactionAt,
          latestAccession: last.accession,
          url: last.url,
          owners: [half.ownerName],
          totalValue: half.value ?? 0,
        });
      } else if (total >= INSIDER_LIMITS.bigSell) {
        out.push({
          kind: "big_sell",
          symbol,
          headline: `Insiders de ${symbol} venden ${money(total)} en ${windowDays} dias`,
          fact: `${owners.length} insider(s) vendieron acciones de ${symbol} por ${money(total)} en los ultimos ${windowDays} dias, fuera de planes 10b5-1: ${owners.slice(0, 3).map((o) => who(sells.find((s) => s.ownerName === o)!)).join(", ")}. Fuente: Form 4 (SEC EDGAR).`,
          materiality: 55,
          thesisImpact: -15,
          occurredAt: last.transactionAt,
          latestAccession: last.accession,
          url: last.url,
          owners,
          totalValue: total,
        });
      }
    }
  }

  return out;
}

/** URL del XML crudo del Form 4: el primario suele venir con el prefijo de la hoja de estilo. */
export function rawForm4Url(url: string): string {
  return url.replace(/\/xsl[^/]+\//, "/");
}

// ---------------------------------------------------------------------------
// Ingesta

export type IngestInsidersResult = {
  companies: number;
  filings: number;
  transactions: number;
  signals: number;
  errors: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ingestInsiders(candidates?: Asset[], now = Date.now()): Promise<IngestInsidersResult> {
  const result: IngestInsidersResult = { companies: 0, filings: 0, transactions: 0, signals: 0, errors: 0 };
  if (!env.secContactEmail) {
    result.error = "Falta SEC_CONTACT_EMAIL: la SEC exige un contacto en el User-Agent.";
    return result;
  }
  const all = candidates ?? (await db.select().from(assets));
  let withCik: Asset[];
  try {
    withCik = await ensureCiks(all.filter((a) => a.assetClass === "equity"));
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
  result.companies = withCik.length;
  if (withCik.length === 0) return result;

  const since = now - INSIDER_LIMITS.maxAgeDays * 86400_000;
  const pending: Array<{ asset: Asset; accession: string; url: string; filedAt: number }> = [];
  for (const a of withCik) {
    try {
      const filings = await recentFilings(a.cik!, since, (f) => f === "4");
      await sleep(EDGAR_LIMITS.pauseMs);
      for (const f of filings) pending.push({ asset: a, accession: f.accession, url: rawForm4Url(f.url), filedAt: f.filedAt });
    } catch (e) {
      result.errors++;
      result.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (pending.length === 0) return result;

  // Solo los que no estan ya en la base.
  const known = new Set(
    (
      await db
        .select({ accession: insiderTransactions.accession })
        .from(insiderTransactions)
        .where(inArray(insiderTransactions.accession, pending.map((p) => p.accession)))
    ).map((r) => r.accession),
  );
  const fresh = pending
    .filter((p) => !known.has(p.accession))
    .sort((a, b) => b.filedAt - a.filedAt)
    .slice(0, INSIDER_LIMITS.docsPerRun);

  const newAccessions = new Set<string>();
  const touched = new Map<string, Asset>();
  for (const p of fresh) {
    try {
      const xml = await (await secFetch(p.url)).text();
      await sleep(EDGAR_LIMITS.pauseMs);
      const form = parseForm4(xml);
      result.filings++;
      if (!form) continue;
      const rows = form.transactions.map((t) => ({
        id: id(),
        assetId: p.asset.id,
        cik: p.asset.cik!,
        symbol: p.asset.symbol.toUpperCase(),
        accession: p.accession,
        txIndex: t.txIndex,
        ownerName: t.ownerName,
        ownerRole: t.ownerRole,
        officerTitle: t.officerTitle,
        code: t.code,
        acquired: t.acquired,
        shares: t.shares,
        price: t.price,
        value: t.value,
        postShares: t.postShares,
        planned: t.planned,
        transactionAt: t.transactionAt,
        filedAt: p.filedAt,
        url: p.url,
        createdAt: now,
      }));
      // Un Form 4 sin operaciones no derivadas (solo derivados) deja una fila
      // vacia para no volver a descargarlo.
      if (rows.length === 0) {
        rows.push({
          id: id(),
          assetId: p.asset.id,
          cik: p.asset.cik!,
          symbol: p.asset.symbol.toUpperCase(),
          accession: p.accession,
          txIndex: -1,
          ownerName: "-",
          ownerRole: "other",
          officerTitle: null,
          code: "-",
          acquired: false,
          shares: 0,
          price: null,
          value: null,
          postShares: null,
          planned: false,
          transactionAt: p.filedAt,
          filedAt: p.filedAt,
          url: p.url,
          createdAt: now,
        });
      }
      await db.insert(insiderTransactions).values(rows).onConflictDoNothing();
      result.transactions += form.transactions.length;
      newAccessions.add(p.accession);
      touched.set(p.asset.id, p.asset);
    } catch (e) {
      result.errors++;
      result.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (touched.size === 0) return result;

  // Senales sobre la ventana completa de cada activo tocado.
  const ctx = await trackedContext();
  const { weights } = await loadWeights().catch(() => ({ weights: undefined, customized: false }));
  const windowSince = now - INSIDER_LIMITS.windowDays * 86400_000;
  for (const asset of touched.values()) {
    const txs = await db
      .select()
      .from(insiderTransactions)
      .where(and(eq(insiderTransactions.assetId, asset.id), gte(insiderTransactions.transactionAt, windowSince)));
    for (const s of insiderSignals(txs, newAccessions, now)) {
      try {
        const created = await createSignalEvent(asset, s, ctx.relevance, weights, now);
        if (created) result.signals++;
      } catch (e) {
        result.errors++;
        result.error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return result;
}

async function createSignalEvent(
  asset: Asset,
  s: InsiderSignal,
  relevanceCtx: Parameters<typeof portfolioRelevance>[1],
  weights: Parameters<typeof scoreSignal>[1] | undefined,
  now: number,
): Promise<boolean> {
  const symbol = asset.symbol.toUpperCase();
  const newsUrl = `${s.url}#insider-${s.kind}`;
  const inserted = await db
    .insert(news)
    .values({
      id: id(),
      headline: s.headline,
      url: newsUrl,
      source: "SEC EDGAR",
      imageUrl: null,
      publishedAt: s.occurredAt,
      kind: "filing",
      body: s.fact,
      summary: s.fact,
      sentiment: s.thesisImpact > 0 ? "bullish" : "bearish",
      impact: s.materiality >= 70 ? "high" : "medium",
      tickers: JSON.stringify([symbol]),
      processedAt: now,
      eventProcessedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: news.id });
  const sourceId =
    inserted[0]?.id ?? (await db.select({ id: news.id }).from(news).where(eq(news.url, newsUrl)).limit(1))[0]?.id;

  const relevance = portfolioRelevance([symbol], relevanceCtx);
  const { score, priority } = scoreSignal(
    {
      materiality: s.materiality,
      confidence: 95,
      thesisImpact: s.thesisImpact,
      portfolioRelevance: relevance,
      sourceTier: 1,
      isNoise: false,
      distinctHosts: 1,
    },
    weights,
  );
  const res = await db
    .insert(events)
    .values({
      id: id(),
      type: "ownership",
      primaryAssetId: asset.id,
      companies: JSON.stringify([symbol]),
      headline: s.headline,
      fact: s.fact,
      inference:
        s.thesisImpact > 0
          ? "Los insiders solo compran en mercado abierto por una razon: creen que vale mas. Es una senal alcista con respaldo empirico, mas fuerte cuanto mas gente y mas dinero."
          : "Una venta de insider tiene muchas explicaciones (liquidez, diversificacion, impuestos) y es una senal debil salvo que sea grande, discrecional y repetida.",
      assessment: INSIDER_ASSESSMENT,
      materiality: s.materiality,
      confidence: 95,
      thesisImpact: s.thesisImpact,
      timeHorizon: "medium",
      portfolioRelevance: relevance,
      sourceTier: 1,
      signalScore: score,
      priority,
      occurredAt: s.occurredAt,
      clusterKey: `insider|${asset.id}|${s.kind}|${s.latestAccession}`,
      model: null,
      promptVersion: INSIDER_PROMPT_VERSION,
      createdAt: now,
    })
    .onConflictDoNothing({ target: events.clusterKey })
    .returning({ id: events.id });
  if (res[0] && sourceId) {
    await db.insert(eventSources).values({ eventId: res[0].id, newsId: sourceId }).onConflictDoNothing();
    return true;
  }
  return false;
}
