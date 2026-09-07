import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, events, fundamentals, theses, thesisAssumptions, thesisChanges, watchlist, type EventRow } from "@/db/schema";
import type { Plan } from "./allocation";
import { money } from "./brief-format";
import type { ConvictionResult } from "./conviction";
import { runMonthlyPlan, type RunHolding } from "./conviction-run";
import type { CryptoPlan } from "./crypto-cycle";
import { getMacro } from "./macro";

/**
 * "Qué hacer": la capa humana encima de todo lo demás. Traduce el veredicto,
 * el plan del mes, los eventos de la semana, los resultados próximos, el
 * estado de las tesis, los precios objetivo de la watchlist y el contexto
 * macro a frases simples con un verbo delante: compra, vende, reduce, revisa,
 * espera. Sin P1, sin scores, sin tiers.
 *
 * Se alimenta de TODO a través de un registro de proveedores (PROVIDERS):
 * cada fuente de la app —presente o futura— aporta sus líneas con la misma
 * forma. Añadir una fuente nueva es añadir un proveedor; el resumen no cambia.
 *
 * Determinista y sin IA: cada frase es una plantilla sobre datos reales, así
 * que nunca dice algo que los números no digan. Puro (`buildBrief`) para
 * poder testearlo; `getBrief` junta los datos.
 */

export type BriefAction = "comprar" | "vender" | "reducir" | "revisar" | "buena_senal" | "esperar" | "vigilar";

export const ACTION_LABEL: Record<BriefAction, string> = {
  comprar: "Compra",
  vender: "Vende",
  reducir: "Reduce",
  revisar: "Revisa",
  buena_senal: "Buena señal",
  esperar: "Espera",
  vigilar: "Vigila",
};

/** Orden de aparición dentro de cada bloque: lo más accionable primero. */
const ACTION_ORDER: Record<BriefAction, number> = {
  vender: 0,
  reducir: 1,
  comprar: 2,
  revisar: 3,
  buena_senal: 4,
  esperar: 5,
  vigilar: 6,
};

export type BriefItem = {
  action: BriefAction;
  symbol: string | null;
  /** Una línea, en imperativo o en titular. */
  title: string;
  /** Una frase con el porqué, sin jerga. */
  why: string;
  amount: number | null;
  href: string | null;
  /** Qué proveedor la generó (para depurar y para tests). */
  source: string;
};

export type BriefMonthLine = { symbol: string; amount: number; why: string; isNew: boolean };

export type Brief = {
  generatedAt: number;
  currency: string;
  /** Una línea que resume todo. */
  summary: string;
  week: { headline: string; items: BriefItem[] };
  month: {
    headline: string;
    equity: { cash: number; lines: BriefMonthLine[]; reserve: number; reserveSymbol: string | null; reserveWhy: string | null };
    crypto: { cash: number; lines: BriefMonthLine[]; reserve: number; extra: number; holding: boolean };
  };
  watch: { headline: string; items: BriefItem[] };
  /** Proveedores que aportaron algo, para saber de qué se alimentó. */
  sources: string[];
};

export type BriefInput = {
  now: number;
  currency: string;
  results: ConvictionResult[];
  holdings: RunHolding[];
  plan: { equity: Plan; crypto: CryptoPlan };
  events: Array<Pick<EventRow, "id" | "headline" | "priority" | "thesisImpact" | "occurredAt" | "companies" | "signalScore">>;
  /** Próximos resultados de posiciones en cartera. */
  earnings: Array<{ symbol: string; at: number }>;
  pendingProposals: number;
  /** Estado de las tesis guardadas: supuestos en riesgo o rotos por activo. */
  thesisStatus: Array<{ symbol: string; atRisk: number; broken: number }>;
  /** Precios objetivo de la watchlist y el precio actual. */
  watchTargets: Array<{ symbol: string; targetPrice: number; direction: "above" | "below" | null; price: number | null }>;
  /** Contexto macro (FRED). */
  macro: { tenY: number | null; spread10y2y: number | null } | null;
};

const DAY = 86400_000;

function daysAgo(ms: number, now: number): string {
  const d = Math.max(0, Math.round((now - ms) / DAY));
  return d === 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} días`;
}

function inDays(ms: number, now: number): string {
  const d = Math.max(0, Math.round((ms - now) / DAY));
  return d === 0 ? "hoy" : d === 1 ? "mañana" : `en ${d} días`;
}

function pct(n: number): string {
  return `${Math.round(Math.abs(n))}%`;
}

/** El factor más flojo, en una frase corta y legible. */
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

// ---------------------------------------------------------------------------
// Proveedores: cada fuente aporta sus líneas. Añadir una fuente = añadir uno.

export type BriefContext = BriefInput & {
  held: Set<string>;
  bySymbol: Map<string, ConvictionResult>;
};

export type BriefProvider = {
  name: string;
  run: (ctx: BriefContext) => { week: BriefItem[]; watch: BriefItem[] };
};

/** Veredicto fundamental: vender, reducir, oportunidades claras y "se pone caro". */
const verdictsProvider: BriefProvider = {
  name: "veredicto",
  run: (ctx) => {
    const week: BriefItem[] = [];
    const watch: BriefItem[] = [];
    for (const r of ctx.results) {
      if (r.posture === "no_coverage") continue;
      const up = r.upsidePct;
      const mos = r.marginOfSafetyPct;
      const expensive = up !== null && up <= -20;
      const weak = weakest(r);
      const inPlan = ctx.plan.equity.lines.find((l) => l.symbol === r.symbol)?.amount ?? null;

      if (r.posture === "sell") {
        week.push({
          action: "vender",
          symbol: r.symbol,
          title: `Vende ${r.symbol}`,
          why: expensive
            ? `Está un ${pct(up)} por encima de lo que vale y el negocio no lo sostiene${weak ? `: ${weak}` : ""}.`
            : `El negocio se ha deteriorado${weak ? `: ${weak}` : ""}.`,
          amount: null,
          href: "/invest/analisis",
          source: "veredicto",
        });
      } else if (r.posture === "reduce") {
        week.push({
          action: "reducir",
          symbol: r.symbol,
          title: `Reduce ${r.symbol}`,
          why: expensive
            ? `Buen negocio pero muy caro: cotiza un ${pct(up)} por encima de su valor razonable. Toma beneficios, sin prisa.`
            : `Fundamentales flojos${weak ? `: ${weak}` : ""}. No metas más dinero y recorta si necesitas liquidez.`,
          amount: null,
          href: "/invest/analisis",
          source: "veredicto",
        });
      } else if ((r.posture === "buy" || r.posture === "strong_buy") && mos !== null && mos >= 25) {
        const isNew = !ctx.held.has(r.symbol.toUpperCase());
        week.push({
          action: "comprar",
          symbol: r.symbol,
          title: isNew ? `${r.symbol} (de tu watchlist) está en zona de compra` : `${r.symbol} está en zona de compra`,
          why: `Cotiza un ${pct(mos)} por debajo de lo que vale. ${whyBuy(r)}${inPlan ? ` El plan del mes le asigna ${money(inPlan, ctx.currency)}.` : ""}`,
          amount: inPlan,
          href: "/invest/analisis",
          source: "veredicto",
        });
      } else if (r.posture === "hold" && mos !== null && mos >= 10 && mos < 25) {
        watch.push({
          action: "vigilar",
          symbol: r.symbol,
          title: `${r.symbol} se acerca a zona de compra`,
          why: `Cotiza un ${pct(mos)} por debajo de lo que vale; con algo más de descuento entra en el plan.`,
          amount: null,
          href: "/invest/analisis",
          source: "veredicto",
        });
      } else if ((r.posture === "hold" || r.posture === "buy") && up !== null && up <= -15) {
        watch.push({
          action: "vigilar",
          symbol: r.symbol,
          title: `${r.symbol} está caro: mantén, pero no añadas`,
          why: `Cotiza un ${pct(up)} por encima de su valor razonable. Buen negocio: no es momento de meter más.`,
          amount: null,
          href: "/invest/analisis",
          source: "veredicto",
        });
      }
    }
    return { week, watch };
  },
};

/** Lo que pasó esta semana (noticias, filings, insiders, 13F) y toca tu cartera. */
const eventsProvider: BriefProvider = {
  name: "eventos",
  run: (ctx) => {
    const week: BriefItem[] = [];
    const recent = ctx.events
      .filter((e) => e.occurredAt >= ctx.now - 7 * DAY && (e.priority === "P1" || e.priority === "P2" || e.priority === "P3"))
      .filter((e) => Math.abs(e.thesisImpact) >= 20 || e.priority === "P1")
      .sort((a, b) => b.signalScore - a.signalScore)
      .slice(0, 3);
    for (const e of recent) {
      const syms = symbolsOf(e.companies).filter((s) => ctx.held.has(s) || ctx.bySymbol.has(s));
      const sym = syms[0] ?? null;
      const negative = e.thesisImpact < 0;
      week.push({
        action: negative ? "revisar" : "buena_senal",
        symbol: sym,
        title: e.headline,
        why: negative
          ? `${daysAgo(e.occurredAt, ctx.now)}. Va en contra de tu tesis${sym ? ` en ${sym}` : ""}: revísala antes de aportar más.`
          : `${daysAgo(e.occurredAt, ctx.now)}. Refuerza tu tesis${sym ? ` en ${sym}` : ""}.`,
        amount: null,
        href: "/invest/alertas",
        source: "eventos",
      });
    }
    return { week, watch: [] };
  },
};

/** Propuestas de cambio de tesis esperando tu sí o no. */
const proposalsProvider: BriefProvider = {
  name: "propuestas",
  run: (ctx) => {
    if (ctx.pendingProposals <= 0) return { week: [], watch: [] };
    const n = ctx.pendingProposals;
    return {
      week: [
        {
          action: "revisar",
          symbol: null,
          title: n === 1 ? "Tienes 1 propuesta de cambio de tesis esperando tu decisión" : `Tienes ${n} propuestas de cambio de tesis esperando tu decisión`,
          why: "El motor propone; tú decides. Nada se aplica solo.",
          amount: null,
          href: "/invest/analisis?tab=tesis&pending=1",
          source: "propuestas",
        },
      ],
      watch: [],
    };
  },
};

/** Tesis con supuestos rotos o en riesgo. */
const thesisProvider: BriefProvider = {
  name: "tesis",
  run: (ctx) => {
    const week: BriefItem[] = [];
    const watch: BriefItem[] = [];
    for (const t of ctx.thesisStatus) {
      if (t.broken > 0) {
        week.push({
          action: "revisar",
          symbol: t.symbol,
          title: `Tu tesis en ${t.symbol} tiene ${t.broken} supuesto${t.broken > 1 ? "s" : ""} roto${t.broken > 1 ? "s" : ""}`,
          why: "Si la razón por la que compraste ya no se cumple, decide si sigue teniendo sentido tenerla.",
          amount: null,
          href: "/invest/analisis?tab=tesis",
          source: "tesis",
        });
      } else if (t.atRisk > 0) {
        watch.push({
          action: "vigilar",
          symbol: t.symbol,
          title: `${t.atRisk} supuesto${t.atRisk > 1 ? "s" : ""} de tu tesis en ${t.symbol} en riesgo`,
          why: "Aún no está roto; conviene mirarlo antes de aportar más.",
          amount: null,
          href: "/invest/analisis?tab=tesis",
          source: "tesis",
        });
      }
    }
    return { week, watch };
  },
};

/** Resultados en los próximos 21 días: si ibas a comprar, espera a verlos. */
const earningsProvider: BriefProvider = {
  name: "resultados",
  run: (ctx) => {
    const watch: BriefItem[] = [];
    for (const e of ctx.earnings) {
      if (e.at < ctx.now || e.at > ctx.now + 21 * DAY) continue;
      const sym = e.symbol.toUpperCase();
      if (!ctx.held.has(sym) && !ctx.bySymbol.has(sym)) continue;
      watch.push({
        action: "esperar",
        symbol: sym,
        title: `${sym} presenta resultados ${inDays(e.at, ctx.now)}`,
        why: "Si ibas a comprar más, espera a ver los números.",
        amount: null,
        href: null,
        source: "resultados",
      });
    }
    return { week: [], watch };
  },
};

/** Precios objetivo que pusiste en la watchlist. */
const watchTargetsProvider: BriefProvider = {
  name: "watchlist",
  run: (ctx) => {
    const week: BriefItem[] = [];
    for (const w of ctx.watchTargets) {
      if (w.price === null || w.price <= 0 || w.targetPrice <= 0) continue;
      const sym = w.symbol.toUpperCase();
      const crossedBelow = w.price <= w.targetPrice && (w.direction === "below" || w.direction === null);
      const crossedAbove = w.price >= w.targetPrice && w.direction === "above";
      if (crossedBelow) {
        const r = ctx.bySymbol.get(sym);
        week.push({
          action: "comprar",
          symbol: sym,
          title: `${sym} llegó a tu precio objetivo (${money(w.targetPrice, ctx.currency)})`,
          why: r && r.posture !== "no_coverage" ? `Y los fundamentales ${r.score >= 64 ? "acompañan" : "no acompañan del todo"} (${r.score}/100 de convicción).` : "Tú fijaste ese precio: decide si sigue valiendo.",
          amount: null,
          href: "/invest/watchlist",
          source: "watchlist",
        });
      } else if (crossedAbove) {
        week.push({
          action: "revisar",
          symbol: sym,
          title: `${sym} superó tu precio objetivo (${money(w.targetPrice, ctx.currency)})`,
          why: "Tú fijaste ese nivel: decide si toca vender o subir el objetivo.",
          amount: null,
          href: "/invest/watchlist",
          source: "watchlist",
        });
      }
    }
    return { week, watch: [] };
  },
};

/** Contexto macro: solo cuando cambia algo que afecta al plan. */
const macroProvider: BriefProvider = {
  name: "macro",
  run: (ctx) => {
    const m = ctx.macro;
    if (!m) return { week: [], watch: [] };
    const watch: BriefItem[] = [];
    if (m.spread10y2y !== null && m.spread10y2y < 0) {
      watch.push({
        action: "vigilar",
        symbol: null,
        title: "La curva de tipos está invertida",
        why: "Históricamente precede a recesiones. No cambia el plan, pero es buen momento para mantener la reserva llena.",
        amount: null,
        href: null,
        source: "macro",
      });
    }
    if (m.tenY !== null && m.tenY >= 5) {
      watch.push({
        action: "vigilar",
        symbol: null,
        title: `El bono a 10 años paga ${m.tenY}%`,
        why: "Con el bono alto, una acción tiene que estar más barata para compensar: el plan ya lo descuenta.",
        amount: null,
        href: null,
        source: "macro",
      });
    }
    return { week: [], watch };
  },
};

/** El registro. El orden importa solo para desempatar; cada bloque se reordena por acción. */
export const PROVIDERS: BriefProvider[] = [
  verdictsProvider,
  eventsProvider,
  proposalsProvider,
  thesisProvider,
  earningsProvider,
  watchTargetsProvider,
  macroProvider,
];

const WEEK_MAX = 10;
const WATCH_MAX = 8;

export function buildBrief(input: BriefInput, providers: BriefProvider[] = PROVIDERS): Brief {
  const { now, currency, plan } = input;
  const ctx: BriefContext = {
    ...input,
    held: new Set(input.holdings.map((h) => h.symbol.toUpperCase())),
    bySymbol: new Map(input.results.map((r) => [r.symbol.toUpperCase(), r])),
  };

  let week: BriefItem[] = [];
  let watch: BriefItem[] = [];
  const sources: string[] = [];
  for (const p of providers) {
    const out = p.run(ctx);
    if (out.week.length || out.watch.length) sources.push(p.name);
    week.push(...out.week);
    watch.push(...out.watch);
  }
  // Se quita solo el duplicado exacto: dos proveedores pueden decir cosas
  // distintas del mismo símbolo con el mismo verbo (un evento de insiders y
  // una tesis rota son ambos "Revisa STX") y las dos merecen aparecer.
  const dedupe = (items: BriefItem[]) => {
    const seen = new Set<string>();
    return items.filter((i) => {
      const k = `${i.action}|${i.symbol ?? ""}|${i.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  week = dedupe(week).sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]).slice(0, WEEK_MAX);
  watch = dedupe(watch).sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]).slice(0, WATCH_MAX);

  // Mes: el plan traducido.
  const eq = plan.equity;
  const equityLines: BriefMonthLine[] = eq.lines.map((l) => {
    const r = ctx.bySymbol.get(l.symbol.toUpperCase());
    const isNew = !ctx.held.has(l.symbol.toUpperCase());
    return {
      symbol: l.symbol,
      amount: l.amount,
      isNew,
      why: `${r ? whyBuy(r) : "Compra planificada."} ${isNew ? "Nueva en cartera." : `Pasa del ${l.weightBefore.toFixed(0)}% al ${l.weightAfter.toFixed(0)}% de tu cartera.`}`,
    };
  });
  const cryptoLines: BriefMonthLine[] = plan.crypto.lines.map((l) => {
    const head = !l.confirmed
      ? `Aporte normal, tramo retenido (la escalera pedía ${l.ladderMultiplier}x)`
      : l.multiplier > 1
        ? `Más de lo habitual (${l.multiplier}x)`
        : l.multiplier < 1
          ? `Menos de lo habitual (${l.multiplier}x)`
          : "Aporte normal";
    return { symbol: l.symbol, amount: l.amount, isNew: false, why: `${head}: ${l.reason}.` };
  });

  const nBuys = equityLines.length;
  const monthHeadline =
    eq.cash <= 0 && plan.crypto.cash <= 0
      ? "No hay aporte configurado este mes."
      : nBuys === 0 && eq.cash > 0
        ? `Este mes no compres nada en bolsa: nada está a buen precio. Guarda los ${money(eq.cash, currency)}${eq.reserveSymbol ? ` en ${eq.reserveSymbol}` : ""}.`
        : `Con tus ${money(eq.cash, currency)} de bolsa: ${equityLines.map((l) => `${l.symbol} ${money(l.amount, currency)}`).join(", ")}${eq.reserve > 0 ? ` y ${money(eq.reserve, currency)} a reserva` : ""}.`;

  const count = (a: BriefAction) => week.filter((w) => w.action === a).length;
  const nSell = count("vender");
  const nReduce = count("reducir");
  const nReview = count("revisar");
  const nGood = count("buena_senal") + count("comprar");
  const bits: string[] = [];
  if (nSell) bits.push(`${nSell} venta${nSell > 1 ? "s" : ""}`);
  if (nReduce) bits.push(`${nReduce} recorte${nReduce > 1 ? "s" : ""}`);
  if (nReview) bits.push(`${nReview} cosa${nReview > 1 ? "s" : ""} que revisar`);
  if (nGood) bits.push(`${nGood} señal${nGood > 1 ? "es" : ""} a favor`);
  const weekHeadline = week.length === 0 ? "Esta semana no hay nada urgente. Sigue el plan del mes." : `Esta semana: ${bits.join(", ")}.`;

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
    week: { headline: weekHeadline, items: week },
    month: {
      headline: monthHeadline,
      equity: { cash: eq.cash, lines: equityLines, reserve: eq.reserve, reserveSymbol: eq.reserveSymbol, reserveWhy: eq.reserveReason },
      crypto: { cash: plan.crypto.cash, lines: cryptoLines, reserve: plan.crypto.reserve, extra: plan.crypto.extra, holding: plan.crypto.holding },
    },
    watch: { headline: watch.length === 0 ? "Nada especial que vigilar." : "Sin prisa, pero atento.", items: watch },
    sources,
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
  const known = [...run.holdings, ...run.candidates];
  const knownIds = known.map((h) => h.assetId);
  const symbolById = new Map(known.map((h) => [h.assetId, h.symbol]));
  const priceById = new Map(known.map((h) => [h.assetId, h.price]));

  const [recent, fund, pending, assumptions, targets, macro] = await Promise.all([
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
    knownIds.length > 0
      ? db
          .select({ assetId: fundamentals.assetId, nextEarningsAt: fundamentals.nextEarningsAt })
          .from(fundamentals)
          .where(inArray(fundamentals.assetId, knownIds))
      : Promise.resolve([] as Array<{ assetId: string; nextEarningsAt: number | null }>),
    db.select({ id: thesisChanges.id }).from(thesisChanges).where(eq(thesisChanges.status, "pending")),
    db
      .select({ symbol: assets.symbol, status: thesisAssumptions.status })
      .from(thesisAssumptions)
      .innerJoin(theses, eq(thesisAssumptions.thesisId, theses.id))
      .innerJoin(assets, eq(theses.assetId, assets.id))
      .where(inArray(thesisAssumptions.status, ["at_risk", "broken"])),
    db
      .select({ assetId: watchlist.assetId, symbol: assets.symbol, targetPrice: watchlist.targetPrice, direction: watchlist.alertDirection })
      .from(watchlist)
      .innerJoin(assets, eq(watchlist.assetId, assets.id)),
    getMacro().catch(() => null),
  ]);

  const earnings = fund
    .filter((f) => f.nextEarningsAt !== null)
    .map((f) => ({ symbol: symbolById.get(f.assetId) ?? "", at: f.nextEarningsAt as number }))
    .filter((e) => e.symbol);

  const statusBySymbol = new Map<string, { symbol: string; atRisk: number; broken: number }>();
  for (const a of assumptions) {
    const s = a.symbol.toUpperCase();
    const cur = statusBySymbol.get(s) ?? { symbol: s, atRisk: 0, broken: 0 };
    if (a.status === "broken") cur.broken++;
    else cur.atRisk++;
    statusBySymbol.set(s, cur);
  }

  const watchTargets = targets
    .filter((t) => t.targetPrice !== null && t.targetPrice > 0)
    .map((t) => ({
      symbol: t.symbol,
      targetPrice: t.targetPrice as number,
      direction: (t.direction === "above" || t.direction === "below" ? t.direction : null) as "above" | "below" | null,
      price: priceById.get(t.assetId) ?? null,
    }));

  const value = buildBrief({
    now,
    currency: run.currency,
    results: run.results,
    holdings: run.holdings,
    plan: { equity: plan.equity, crypto: plan.crypto },
    events: recent,
    earnings,
    pendingProposals: pending.length,
    thesisStatus: [...statusBySymbol.values()],
    watchTargets,
    macro: macro && macro.available ? { tenY: macro.tenY, spread10y2y: macro.spread10y2y } : null,
  });
  memo = { at: now, value };
  return value;
}
