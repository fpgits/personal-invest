import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, fundamentals, thesisChanges, type EventRow } from "@/db/schema";
import type { Plan } from "./allocation";
import type { ConvictionResult } from "./conviction";
import { runMonthlyPlan, type RunHolding } from "./conviction-run";
import type { CryptoPlan } from "./crypto-cycle";
import { money } from "./brief-format";

/**
 * "Que hacer": la capa humana encima del oraculo. Traduce el veredicto, el
 * plan del mes, los eventos de la semana, los resultados proximos y las
 * propuestas de tesis pendientes a frases simples con un verbo delante:
 * compra, vende, reduce, revisa, espera. Sin P1, sin scores, sin tiers.
 *
 * Determinista y sin IA: cada frase es una plantilla sobre datos reales, asi
 * que nunca dice algo que los numeros no digan. Puro (`buildBrief`) para
 * poder testearlo; `getBrief` junta los datos.
 */

export type BriefAction = "comprar" | "vender" | "reducir" | "revisar" | "buena_senal" | "esperar" | "vigilar";

export const ACTION_LABEL: Record<BriefAction, string> = {
  comprar: "Compra",
  vender: "Vende",
  reducir: "Reduce",
  revisar: "Revisa",
  buena_senal: "Buena senal",
  esperar: "Espera",
  vigilar: "Vigila",
};

export type BriefItem = {
  action: BriefAction;
  symbol: string | null;
  /** Una linea, en imperativo o en titular. */
  title: string;
  /** Una frase con el porque, sin jerga. */
  why: string;
  amount: number | null;
  href: string | null;
};

export type BriefMonthLine = { symbol: string; amount: number; why: string };

export type Brief = {
  generatedAt: number;
  currency: string;
  /** Una linea que resume todo. */
  summary: string;
  week: { headline: string; items: BriefItem[] };
  month: {
    headline: string;
    equity: { cash: number; lines: BriefMonthLine[]; reserve: number; reserveSymbol: string | null; reserveWhy: string | null };
    crypto: { cash: number; lines: BriefMonthLine[]; reserve: number; extra: number };
  };
  watch: { headline: string; items: BriefItem[] };
};

export type BriefInput = {
  now: number;
  currency: string;
  results: ConvictionResult[];
  holdings: RunHolding[];
  plan: { equity: Plan; crypto: CryptoPlan };
  events: Array<Pick<EventRow, "id" | "headline" | "priority" | "thesisImpact" | "occurredAt" | "companies" | "signalScore">>;
  /** Proximos resultados de posiciones en cartera. */
  earnings: Array<{ symbol: string; at: number }>;
  pendingProposals: number;
};

const DAY = 86400_000;


function daysAgo(ms: number, now: number): string {
  const d = Math.max(0, Math.round((now - ms) / DAY));
  return d === 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} dias`;
}

function inDays(ms: number, now: number): string {
  const d = Math.max(0, Math.round((ms - now) / DAY));
  return d === 0 ? "hoy" : d === 1 ? "manana" : `en ${d} dias`;
}

function pct(n: number): string {
  return `${Math.round(Math.abs(n))}%`;
}

/** El factor mas flojo, en una frase corta y legible. */
function weakest(r: ConvictionResult): string | null {
  const scored = r.factors.filter((f) => f.score !== null) as Array<(typeof r.factors)[number] & { score: number }>;
  if (scored.length === 0) return null;
  const w = [...scored].sort((a, b) => a.score - b.score)[0];
  if (w.score >= 50) return null;
  return `${w.label.toLowerCase()} floja (${w.detail})`;
}

function symbolsOf(companies: string): string[] {
  try {
    const arr = JSON.parse(companies) as unknown;
    return Array.isArray(arr) ? arr.map((s) => String(s).toUpperCase()) : [];
  } catch {
    return [];
  }
}

function whyBuy(r: ConvictionResult): string {
  const mos = r.marginOfSafetyPct;
  const cheap = mos !== null && mos >= 15;
  if (r.score >= 78 && cheap) return `Negocio excelente y con descuento: cotiza un ${pct(mos)} por debajo de lo que vale.`;
  if (r.score >= 78) return "Negocio excelente a un precio justo.";
  if (cheap) return `Buen negocio con descuento: un ${pct(mos)} por debajo de lo que vale.`;
  return "Buen negocio a un precio razonable.";
}

export function buildBrief(input: BriefInput): Brief {
  const { now, currency, results, holdings, plan } = input;
  const held = new Set(holdings.map((h) => h.symbol.toUpperCase()));
  const bySymbol = new Map(results.map((r) => [r.symbol.toUpperCase(), r]));
  const week: BriefItem[] = [];
  const watch: BriefItem[] = [];

  // 1) Vender / reducir: lo que el oraculo pide soltar, esta semana.
  for (const r of results) {
    if (r.posture !== "sell" && r.posture !== "reduce") continue;
    const up = r.upsidePct;
    const expensive = up !== null && up <= -20;
    const weak = weakest(r);
    if (r.posture === "sell") {
      week.push({
        action: "vender",
        symbol: r.symbol,
        title: `Vende ${r.symbol}`,
        why: expensive
          ? `Esta un ${pct(up)} por encima de lo que vale y el negocio no lo sostiene${weak ? `: ${weak}` : ""}.`
          : `El negocio se ha deteriorado${weak ? `: ${weak}` : ""}.`,
        amount: null,
        href: "/invest/analisis",
      });
    } else {
      week.push({
        action: "reducir",
        symbol: r.symbol,
        title: `Reduce ${r.symbol}`,
        why: expensive
          ? `Buen negocio pero caro: cotiza un ${pct(up)} por encima de su valor razonable. Toma beneficios.`
          : `Fundamentales flojos${weak ? `: ${weak}` : ""}. No metas mas dinero y recorta si necesitas liquidez.`,
        amount: null,
        href: "/invest/analisis",
      });
    }
  }

  // 2) Oportunidad clara esta semana: en zona de compra con descuento grande.
  for (const r of results) {
    if ((r.posture !== "buy" && r.posture !== "strong_buy") || r.marginOfSafetyPct === null || r.marginOfSafetyPct < 25) continue;
    week.push({
      action: "comprar",
      symbol: r.symbol,
      title: `${r.symbol} esta en zona de compra`,
      why: `Cotiza un ${pct(r.marginOfSafetyPct)} por debajo de lo que vale. ${whyBuy(r)}`,
      amount: plan.equity.lines.find((l) => l.symbol === r.symbol)?.amount ?? null,
      href: "/invest/analisis",
    });
  }

  // 3) Lo que paso esta semana y toca tu cartera.
  const recent = input.events
    .filter((e) => e.occurredAt >= now - 7 * DAY && (e.priority === "P1" || e.priority === "P2" || e.priority === "P3"))
    .filter((e) => Math.abs(e.thesisImpact) >= 20 || e.priority === "P1")
    .sort((a, b) => b.signalScore - a.signalScore);
  let added = 0;
  for (const e of recent) {
    if (added >= 3) break;
    const syms = symbolsOf(e.companies).filter((s) => held.has(s) || bySymbol.has(s));
    const sym = syms[0] ?? null;
    const negative = e.thesisImpact < 0;
    week.push({
      action: negative ? "revisar" : "buena_senal",
      symbol: sym,
      title: e.headline,
      why: negative
        ? `${daysAgo(e.occurredAt, now)}. Va en contra de tu tesis${sym ? ` en ${sym}` : ""}: revisala antes de aportar mas.`
        : `${daysAgo(e.occurredAt, now)}. Refuerza tu tesis${sym ? ` en ${sym}` : ""}.`,
      amount: null,
      href: "/invest/alertas",
    });
    added++;
  }

  // 4) Propuestas de tesis esperando tu si o no.
  if (input.pendingProposals > 0) {
    week.push({
      action: "revisar",
      symbol: null,
      title:
        input.pendingProposals === 1
          ? "Tienes 1 propuesta de cambio de tesis esperando tu decision"
          : `Tienes ${input.pendingProposals} propuestas de cambio de tesis esperando tu decision`,
      why: "El motor propone; tu decides. Nada se aplica solo.",
      amount: null,
      href: "/invest/analisis?tab=tesis&pending=1",
    });
  }

  // Vigilar: resultados proximos, lo que se acerca a zona de compra, lo que se pone caro.
  for (const e of input.earnings) {
    if (e.at < now || e.at > now + 21 * DAY) continue;
    const sym = e.symbol.toUpperCase();
    if (!held.has(sym)) continue;
    watch.push({
      action: "esperar",
      symbol: sym,
      title: `${sym} presenta resultados ${inDays(e.at, now)}`,
      why: "Si ibas a comprar mas, espera a ver los numeros.",
      amount: null,
      href: null,
    });
  }
  for (const r of results) {
    if (r.posture === "no_coverage") continue;
    const mos = r.marginOfSafetyPct;
    const up = r.upsidePct;
    if (r.posture === "hold" && mos !== null && mos >= 10 && mos < 25) {
      watch.push({
        action: "vigilar",
        symbol: r.symbol,
        title: `${r.symbol} se acerca a zona de compra`,
        why: `Cotiza un ${pct(mos)} por debajo de lo que vale; con algo mas de descuento entra en el plan.`,
        amount: null,
        href: "/invest/analisis",
      });
    } else if ((r.posture === "hold" || r.posture === "buy") && up !== null && up <= -15 && up > -30) {
      watch.push({
        action: "vigilar",
        symbol: r.symbol,
        title: `${r.symbol} se esta poniendo caro`,
        why: `Cotiza un ${pct(up)} por encima de su valor razonable. Buen negocio; no es momento de anadir.`,
        amount: null,
        href: "/invest/analisis",
      });
    }
  }

  // Mes: el plan traducido.
  const eq = plan.equity;
  const equityLines: BriefMonthLine[] = eq.lines.map((l) => {
    const r = bySymbol.get(l.symbol.toUpperCase());
    return {
      symbol: l.symbol,
      amount: l.amount,
      why: `${r ? whyBuy(r) : "Compra planificada."} Pasa del ${l.weightBefore.toFixed(0)}% al ${l.weightAfter.toFixed(0)}% de tu cartera.`,
    };
  });
  const cryptoLines: BriefMonthLine[] = plan.crypto.lines.map((l) => ({
    symbol: l.symbol,
    amount: l.amount,
    why:
      l.multiplier > 1
        ? `Mas de lo habitual (${l.multiplier}x): ${l.reason}.`
        : l.multiplier < 1
          ? `Menos de lo habitual (${l.multiplier}x): ${l.reason}.`
          : "Aporte normal.",
  }));

  const nBuys = equityLines.length;
  const monthHeadline =
    eq.cash <= 0 && plan.crypto.cash <= 0
      ? "No hay aporte configurado este mes."
      : nBuys === 0 && eq.cash > 0
        ? `Este mes no compres nada en bolsa: nada esta a buen precio. Guarda los ${money(eq.cash, currency)}${eq.reserveSymbol ? ` en ${eq.reserveSymbol}` : ""}.`
        : `Con tus ${money(eq.cash, currency)} de bolsa: ${equityLines.map((l) => `${l.symbol} ${money(l.amount, currency)}`).join(", ")}${eq.reserve > 0 ? ` y ${money(eq.reserve, currency)} a reserva` : ""}.`;

  const nSell = week.filter((w) => w.action === "vender").length;
  const nReduce = week.filter((w) => w.action === "reducir").length;
  const nReview = week.filter((w) => w.action === "revisar").length;
  const nGood = week.filter((w) => w.action === "buena_senal" || w.action === "comprar").length;
  const weekBits: string[] = [];
  if (nSell) weekBits.push(`${nSell} venta${nSell > 1 ? "s" : ""}`);
  if (nReduce) weekBits.push(`${nReduce} recorte${nReduce > 1 ? "s" : ""}`);
  if (nReview) weekBits.push(`${nReview} cosa${nReview > 1 ? "s" : ""} que revisar`);
  if (nGood) weekBits.push(`${nGood} senal${nGood > 1 ? "es" : ""} a favor`);
  const weekHeadline =
    week.length === 0 ? "Esta semana no hay nada urgente. Sigue el plan del mes." : `Esta semana: ${weekBits.join(", ")}.`;

  const summary = [
    weekHeadline,
    nBuys > 0
      ? `Este mes: ${nBuys} compra${nBuys > 1 ? "s" : ""} por ${money(eq.cash - eq.reserve, currency)}${plan.crypto.cash > 0 ? ` y ${money(plan.crypto.cash, currency)} a cripto` : ""}.`
      : eq.cash > 0
        ? `Este mes: nada a buen precio en bolsa; reserva${plan.crypto.cash > 0 ? ` y ${money(plan.crypto.cash, currency)} a cripto` : ""}.`
        : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    generatedAt: now,
    currency,
    summary,
    week: { headline: weekHeadline, items: week.slice(0, 8) },
    month: {
      headline: monthHeadline,
      equity: { cash: eq.cash, lines: equityLines, reserve: eq.reserve, reserveSymbol: eq.reserveSymbol, reserveWhy: eq.reserveReason },
      crypto: { cash: plan.crypto.cash, lines: cryptoLines, reserve: plan.crypto.reserve, extra: plan.crypto.extra },
    },
    watch: {
      headline: watch.length === 0 ? "Nada especial que vigilar." : "Sin prisa, pero atento.",
      items: watch.slice(0, 6),
    },
  };
}

// ---------------------------------------------------------------------------
// Datos

const TTL_MS = 30 * 60_000;
let memo: { at: number; value: Brief } | null = null;

export async function getBrief(opts: { force?: boolean } = {}, now = Date.now()): Promise<Brief> {
  if (!opts.force && memo && now - memo.at < TTL_MS) return memo.value;

  const plan = await runMonthlyPlan({ save: false });
  const run = plan.run;
  const heldIds = run.holdings.map((h) => h.assetId);

  const [recent, fund, pending] = await Promise.all([
    db
      .select({
        id: events.id,
        headline: events.headline,
        priority: events.priority,
        thesisImpact: events.thesisImpact,
        occurredAt: events.occurredAt,
        companies: events.companies,
        signalScore: events.signalScore,
      })
      .from(events)
      .where(and(gte(events.occurredAt, now - 7 * DAY), inArray(events.priority, ["P1", "P2", "P3"])))
      .orderBy(desc(events.signalScore))
      .limit(30),
    heldIds.length > 0
      ? db
          .select({ assetId: fundamentals.assetId, nextEarningsAt: fundamentals.nextEarningsAt })
          .from(fundamentals)
          .where(inArray(fundamentals.assetId, heldIds))
      : Promise.resolve([] as Array<{ assetId: string; nextEarningsAt: number | null }>),
    db.select({ id: thesisChanges.id }).from(thesisChanges).where(eq(thesisChanges.status, "pending")),
  ]);

  const symbolById = new Map(run.holdings.map((h) => [h.assetId, h.symbol]));
  const earnings = fund
    .filter((f) => f.nextEarningsAt !== null)
    .map((f) => ({ symbol: symbolById.get(f.assetId) ?? "", at: f.nextEarningsAt as number }))
    .filter((e) => e.symbol);

  const value = buildBrief({
    now,
    currency: run.currency,
    results: run.results,
    holdings: run.holdings,
    plan: { equity: plan.equity, crypto: plan.crypto },
    events: recent,
    earnings,
    pendingProposals: pending.length,
  });
  memo = { at: now, value };
  return value;
}
