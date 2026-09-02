import { eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { assets, news, type Asset } from "@/db/schema";
import { env } from "./env";
import { id } from "./utils";

/**
 * SEC EDGAR: la fuente primaria. Un 8-K es una comunicacion obligatoria de la
 * empresa (resultados, salida de un directivo, acuerdo material...), sin la
 * capa de interpretacion de un medio. Es tier 1 en el motor de eventos y su
 * texto entra en el prompt de extraccion, cosa que con los agregadores no
 * hacemos (no descargamos articulos de terceros).
 *
 * Reglas de acceso de la SEC: User-Agent identificado, <= 10 peticiones por
 * segundo. Aqui vamos en serie y con pausa, muy por debajo.
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const ARCHIVE_URL = (cikNum: string, accNoDashes: string) =>
  `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDashes}`;

export const EDGAR_LIMITS = {
  /** Filings mas viejos que esto no se ingieren: llegarian tarde. */
  maxAgeDays: 14,
  /** Documentos que se descargan por pasada (cada uno son 1-3 peticiones). */
  docsPerRun: 8,
  /** Texto maximo que se guarda por filing. */
  bodyChars: 20_000,
  /** Pausa entre peticiones a la SEC. */
  pauseMs: 150,
} as const;

/** Formularios que interesan y su impacto por defecto (el 8-K depende de sus items). */
export const FORM_IMPACT: Record<string, "high" | "medium"> = {
  "10-K": "high",
  "10-Q": "high",
  "20-F": "high",
  "6-K": "medium",
  "SC 13D": "high",
  "8-K": "medium",
  "8-K/A": "medium",
  "10-K/A": "medium",
  "10-Q/A": "medium",
};

/** Items de 8-K: etiqueta en espanol e impacto. */
export const ITEM_8K: Record<string, { label: string; impact: "high" | "medium" | "low" }> = {
  "1.01": { label: "Acuerdo material", impact: "high" },
  "1.02": { label: "Terminacion de acuerdo material", impact: "high" },
  "1.03": { label: "Quiebra o concurso", impact: "high" },
  "1.05": { label: "Incidente de ciberseguridad material", impact: "high" },
  "2.01": { label: "Adquisicion o venta de activos", impact: "high" },
  "2.02": { label: "Resultados de operaciones", impact: "high" },
  "2.03": { label: "Nueva obligacion financiera", impact: "medium" },
  "2.04": { label: "Aceleracion de obligacion", impact: "high" },
  "2.05": { label: "Costes de reestructuracion", impact: "high" },
  "2.06": { label: "Deterioro de activos", impact: "high" },
  "3.01": { label: "Aviso de exclusion de cotizacion", impact: "high" },
  "3.02": { label: "Venta no registrada de acciones", impact: "medium" },
  "3.03": { label: "Modificacion de derechos de accionistas", impact: "medium" },
  "4.01": { label: "Cambio de auditor", impact: "high" },
  "4.02": { label: "Estados financieros previos no fiables", impact: "high" },
  "5.01": { label: "Cambio de control", impact: "high" },
  "5.02": { label: "Salida o nombramiento de directivos", impact: "high" },
  "5.03": { label: "Cambios en estatutos", impact: "medium" },
  "5.07": { label: "Votacion de accionistas", impact: "low" },
  "7.01": { label: "Regulation FD", impact: "medium" },
  "8.01": { label: "Otros eventos", impact: "medium" },
  "9.01": { label: "Estados financieros y anexos", impact: "low" },
};

export type Filing = {
  form: string;
  filedAt: number;
  accession: string;
  primaryDoc: string;
  description: string;
  items: string[];
  url: string;
};

export type Classified = { impact: "high" | "medium" | "low"; label: string; skip: boolean };

/** Impacto y etiqueta de un filing. `skip` para lo que no merece una noticia. */
export function classifyFiling(form: string, items: string[]): Classified {
  const base = FORM_IMPACT[form];
  if (!base) return { impact: "low", label: form, skip: true };
  if (!form.startsWith("8-K")) return { impact: base, label: formLabel(form), skip: false };

  const known = items.map((i) => ITEM_8K[i]).filter(Boolean);
  const meaningful = items.filter((i) => i !== "9.01");
  if (meaningful.length === 0) return { impact: "low", label: "Solo anexos", skip: true };
  const impact = known.some((k) => k.impact === "high")
    ? "high"
    : known.some((k) => k.impact === "medium")
      ? "medium"
      : "low";
  const label = meaningful
    .map((i) => `Item ${i}${ITEM_8K[i] ? ` (${ITEM_8K[i].label})` : ""}`)
    .join(", ");
  return { impact, label, skip: impact === "low" };
}

function formLabel(form: string): string {
  switch (form) {
    case "10-K":
      return "Informe anual (10-K)";
    case "10-Q":
      return "Informe trimestral (10-Q)";
    case "20-F":
      return "Informe anual de emisor extranjero (20-F)";
    case "6-K":
      return "Comunicacion de emisor extranjero (6-K)";
    case "SC 13D":
      return "Participacion significativa con intencion (SC 13D)";
    default:
      return form;
  }
}

/** Texto plano a partir del HTML de EDGAR (incluido iXBRL). Puro y testeable. */
export function htmlToText(html: string, max: number = EDGAR_LIMITS.bodyChars): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/section)[^>]*>/gi, "\n")
    .replace(/<\s*(\/td|\/th)[^>]*>/gi, " \t ")
    // Etiquetas en linea (b, span, ix:nonFraction...) desaparecen sin
    // meter espacios: "Operations</b>." debe quedar "Operations.".
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
    hellip: "…", copy: "©", reg: "®", trade: "™", sect: "§", bull: "•",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/**
 * Parsea `filings.recent` del JSON de submissions (arrays paralelos) a
 * filings recientes de los formularios que interesan. Puro y testeable.
 */
export function parseSubmissions(
  json: unknown,
  cik: string,
  sinceMs: number,
): Filing[] {
  const recent = (json as { filings?: { recent?: Record<string, unknown[]> } })?.filings?.recent;
  if (!recent) return [];
  const forms = (recent.form ?? []) as string[];
  const dates = (recent.filingDate ?? []) as string[];
  const accs = (recent.accessionNumber ?? []) as string[];
  const docs = (recent.primaryDocument ?? []) as string[];
  const descs = (recent.primaryDocDescription ?? []) as string[];
  const items = (recent.items ?? []) as string[];
  const cikNum = String(Number(cik));

  const out: Filing[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (!FORM_IMPACT[form]) continue;
    const filedAt = Date.parse(`${dates[i]}T12:00:00Z`);
    if (!Number.isFinite(filedAt) || filedAt < sinceMs) continue;
    const accession = accs[i];
    const primaryDoc = docs[i];
    if (!accession || !primaryDoc) continue;
    out.push({
      form,
      filedAt,
      accession,
      primaryDoc,
      description: descs[i] ?? "",
      items: String(items[i] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      url: `${ARCHIVE_URL(cikNum, accession.replace(/-/g, ""))}/${primaryDoc}`,
    });
  }
  return out.sort((a, b) => b.filedAt - a.filedAt);
}

export function padCik(raw: string | number): string {
  return String(raw).replace(/\D/g, "").padStart(10, "0");
}

// ---------------------------------------------------------------------------
// Red

function userAgent(): string {
  const contact = env.secContactEmail || "sin-email-configurado";
  return `personal-invest/1.0 (${contact})`;
}

async function secFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json, text/html;q=0.9, */*;q=0.5" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`SEC respondio ${res.status} en ${url}`);
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cikCache: { at: number; map: Map<string, string> } | null = null;

/** ticker → CIK (10 digitos). Cacheado 24 h en memoria; ~700 KB por descarga. */
export async function loadCikMap(): Promise<Map<string, string>> {
  if (cikCache && Date.now() - cikCache.at < 86400_000) return cikCache.map;
  const json = (await (await secFetch(TICKERS_URL)).json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const map = new Map<string, string>();
  for (const row of Object.values(json)) {
    if (row?.ticker && row.cik_str) map.set(row.ticker.toUpperCase(), padCik(row.cik_str));
  }
  cikCache = { at: Date.now(), map };
  return map;
}

/** Rellena `assets.cik` para las acciones que aun no lo tienen. */
export async function ensureCiks(candidates: Asset[]): Promise<Asset[]> {
  const equities = candidates.filter((a) => a.assetClass === "equity");
  const missing = equities.filter((a) => !a.cik);
  if (missing.length > 0) {
    const map = await loadCikMap();
    for (const a of missing) {
      const cik = map.get((a.providerId || a.symbol).toUpperCase());
      if (cik) {
        await db.update(assets).set({ cik }).where(eq(assets.id, a.id));
        a.cik = cik;
      }
    }
  }
  return equities.filter((a) => a.cik);
}

export async function recentFilings(cik: string, sinceMs: number): Promise<Filing[]> {
  const json = await (await secFetch(SUBMISSIONS_URL(cik))).json();
  return parseSubmissions(json, cik, sinceMs);
}

/**
 * Texto del documento principal. Para un 8-K la carta suele ser boilerplate y
 * lo interesante va en el anexo 99 (la nota de prensa): si el principal es
 * corto, se anade el primer EX-99 del indice del filing.
 */
export async function fetchFilingText(filing: Filing, cik: string): Promise<string> {
  const html = await (await secFetch(filing.url)).text();
  let text = htmlToText(html);

  if (filing.form.startsWith("8-K") && text.length < 2500) {
    await sleep(EDGAR_LIMITS.pauseMs);
    const base = ARCHIVE_URL(String(Number(cik)), filing.accession.replace(/-/g, ""));
    try {
      const index = (await (await secFetch(`${base}/index.json`)).json()) as {
        directory?: { item?: Array<{ name?: string }> };
      };
      const exhibit = (index.directory?.item ?? [])
        .map((i) => i.name ?? "")
        .find((n) => /ex[-_]?99/i.test(n) && /\.html?$/i.test(n));
      if (exhibit) {
        await sleep(EDGAR_LIMITS.pauseMs);
        const ex = await (await secFetch(`${base}/${exhibit}`)).text();
        text = `${text}\n\n[Anexo 99]\n${htmlToText(ex, EDGAR_LIMITS.bodyChars - text.length)}`;
      }
    } catch {
      // Sin anexo nos quedamos con la carta; mejor poco que nada.
    }
  }
  return text.slice(0, EDGAR_LIMITS.bodyChars);
}

export type IngestFilingsResult = {
  companies: number;
  scanned: number;
  inserted: number;
  errors: number;
  error?: string;
};

/**
 * Ingiere filings recientes de las acciones seguidas como filas de `news`
 * (kind = filing, fuente SEC EDGAR). Llegan ya "resumidas" de forma
 * deterministica (formulario e items), con impacto y con el texto en `body`,
 * asi que el motor de eventos las puede usar sin pasar por el modelo rapido.
 */
export async function ingestFilings(candidates?: Asset[]): Promise<IngestFilingsResult> {
  const result: IngestFilingsResult = { companies: 0, scanned: 0, inserted: 0, errors: 0 };
  if (!env.secContactEmail) {
    result.error = "Falta SEC_CONTACT_EMAIL: la SEC exige un contacto en el User-Agent.";
    return result;
  }

  const all = candidates ?? (await db.select().from(assets));
  let withCik: Asset[];
  try {
    withCik = await ensureCiks(all);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
  result.companies = withCik.length;
  if (withCik.length === 0) return result;

  const since = Date.now() - EDGAR_LIMITS.maxAgeDays * 86400_000;
  const pending: Array<{ asset: Asset; filing: Filing; cls: Classified }> = [];

  for (const a of withCik) {
    try {
      const filings = await recentFilings(a.cik!, since);
      await sleep(EDGAR_LIMITS.pauseMs);
      for (const f of filings) {
        const cls = classifyFiling(f.form, f.items);
        result.scanned++;
        if (!cls.skip) pending.push({ asset: a, filing: f, cls });
      }
    } catch (e) {
      result.errors++;
      result.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (pending.length === 0) return result;

  // Solo se descargan los que no estan ya en la base.
  const known = new Set(
    (
      await db
        .select({ url: news.url })
        .from(news)
        .where(inArray(news.url, pending.map((p) => p.filing.url)))
    ).map((r) => r.url),
  );
  const fresh = pending
    .filter((p) => !known.has(p.filing.url))
    .sort((a, b) => b.filing.filedAt - a.filing.filedAt)
    .slice(0, EDGAR_LIMITS.docsPerRun);

  for (const { asset, filing, cls } of fresh) {
    try {
      const body = await fetchFilingText(filing, asset.cik!);
      await sleep(EDGAR_LIMITS.pauseMs);
      const filedDay = new Date(filing.filedAt).toISOString().slice(0, 10);
      const symbol = asset.symbol.toUpperCase();
      const res = await db
        .insert(news)
        .values({
          id: id(),
          headline: `${symbol} presenta ${filing.form} ante la SEC: ${cls.label}`,
          url: filing.url,
          source: "SEC EDGAR",
          imageUrl: null,
          publishedAt: filing.filedAt,
          kind: "filing",
          body,
          summary: `Documento primario presentado el ${filedDay}${filing.description ? ` (${filing.description})` : ""}. ${cls.label}.`,
          sentiment: "neutral",
          impact: cls.impact,
          tickers: JSON.stringify([symbol]),
          processedAt: Date.now(),
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning({ id: news.id });
      if (res.length > 0) result.inserted++;
    } catch (e) {
      result.errors++;
      result.error = e instanceof Error ? e.message : String(e);
    }
  }

  return result;
}

/** Activos sin CIK y sin intento reciente: util para diagnosticar cobertura. */
export async function equitiesWithoutCik(): Promise<Asset[]> {
  return db.select().from(assets).where(isNull(assets.cik));
}
