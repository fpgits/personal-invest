import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, watchlist } from "@/db/schema";
import { allocate, type Plan } from "./allocation";
import { companyFinancials } from "./edgar-facts";
import { getFundamentalsMap } from "./fundamentals";
import { evaluate, rankResults, type ConvictionResult } from "./conviction";
import { recordBatch } from "./conviction-calls";
import { specialCandidates } from "./special-run";
import { basketTicket } from "./special-situations";
import { cryptoPlan, cycleStatsFor, parseCore, type CryptoPlan } from "./crypto-cycle";
import { getMacro, riskFreeRate } from "./macro";
import { getCachedQuotes } from "./market";
import { computePortfolio } from "./portfolio";
import { resolveOracleSettings, type OracleSettings } from "./settings";
import { collectSignalsFor } from "./signals-run";
import { batched } from "./utils";

/**
 * Corre el motor de conviccion sobre la cartera real Y la watchlist: junta
 * posiciones, precios, fundamentales de Finnhub, historico de EDGAR y el tipo
 * libre de riesgo de FRED y devuelve el veredicto ordenado por accionabilidad.
 * Los de la watchlist entran como candidatos (sin posicion): asi "que comprar"
 * puede traer nombres nuevos y el plan del mes puede asignarles dinero. Todo
 * mejor esfuerzo: si una fuente falla para un activo, se evalua con lo que
 * haya y baja la confianza.
 */
export type RunHolding = {
  symbol: string;
  assetId: string;
  assetClass: string;
  price: number;
  value: number;
  weight: number;
};

export type ConvictionRun = {
  results: ConvictionResult[];
  holdings: RunHolding[];
  /** Candidatos de la watchlist evaluados (sin posicion). */
  candidates: RunHolding[];
  asOf: number;
  currency: string;
  macroAvailable: boolean;
  riskFree: number | null;
};

export async function runConviction(): Promise<ConvictionRun> {
  const [portfolio, macro] = await Promise.all([
    computePortfolio(),
    getMacro().catch(() => null),
  ]);
  const rf = macro ? riskFreeRate(macro) : null;

  const positions = portfolio.positions.filter((p) => p.asset.assetClass !== "cash");
  const heldIds = new Set(positions.map((p) => p.asset.id));

  // Candidatos: la watchlist que no esta en cartera, con su precio en cache.
  const watched = await db
    .select({ asset: assets })
    .from(watchlist)
    .innerJoin(assets, eq(watchlist.assetId, assets.id))
    .catch(() => [] as Array<{ asset: typeof assets.$inferSelect }>);
  const candidates = watched.map((w) => w.asset).filter((a) => !heldIds.has(a.id) && a.assetClass !== "cash");
  const candidateQuotes = await getCachedQuotes(candidates).catch(() => ({}) as Awaited<ReturnType<typeof getCachedQuotes>>);

  type Target = {
    asset: typeof assets.$inferSelect;
    price: number;
    position: { unrealizedPct: number; weight: number } | null;
  };
  const targets: Target[] = [
    ...positions.map((p) => ({ asset: p.asset, price: p.price, position: { unrealizedPct: p.unrealizedPct, weight: p.weight } })),
    ...candidates.map((a) => ({ asset: a, price: candidateQuotes[a.id]?.price ?? 0, position: null })),
  ];
  const fmap = await getFundamentalsMap(
    targets.filter((t) => t.asset.assetClass !== "crypto").map((t) => t.asset.id),
  );

  // La union: todo lo demas que sabemos de cada activo (directivos, gestores
  // seguidos, hechos recientes, estado de tu tesis). Se lee de una vez y entra
  // en evaluate() como modificador acotado. Mejor esfuerzo: si falla, el
  // veredicto sale solo con fundamentales, como antes.
  const signalMap = await collectSignalsFor(
    targets
      .filter((t) => t.asset.assetClass !== "crypto")
      .map((t) => ({ symbol: t.asset.symbol, assetId: t.asset.id })),
  ).catch(() => ({}) as Awaited<ReturnType<typeof collectSignalsFor>>);

  // Concurrencia baja: EDGAR hace varias peticiones por empresa (limite ~10/s).
  const results = await batched(targets, 2, async (t) => {
    const a = t.asset;
    const fund = fmap.get(a.id) ?? null;
    let financials = null;
    if (a.assetClass !== "crypto" && a.cik) {
      financials = await companyFinancials(a.cik).catch(() => null);
    }
    return evaluate({
      symbol: a.symbol,
      name: a.name,
      assetClass: a.assetClass,
      price: t.price > 0 ? t.price : null,
      fundamentals: fund?.metrics ?? null,
      earnings: fund?.earnings ?? [],
      financials,
      riskFreeRate: rf,
      position: t.position,
      signals: signalMap[a.symbol.toUpperCase()],
    });
  });

  return {
    results: rankResults(results),
    holdings: positions.map((p) => ({
      symbol: p.asset.symbol,
      assetId: p.asset.id,
      assetClass: p.asset.assetClass,
      price: p.price,
      value: p.value,
      weight: p.weight,
    })),
    candidates: candidates.map((a) => ({
      symbol: a.symbol,
      assetId: a.id,
      assetClass: a.assetClass,
      price: candidateQuotes[a.id]?.price ?? 0,
      value: 0,
      weight: 0,
    })),
    asOf: Date.now(),
    currency: portfolio.currency,
    macroAvailable: Boolean(macro?.available),
    riskFree: rf,
  };
}

// ---------------------------------------------------------------------------
// Plan mensual

export type MonthlyPlan = {
  equity: Plan;
  crypto: CryptoPlan;
  settings: OracleSettings;
  run: ConvictionRun;
  /** Id del lote guardado en conviction_calls, si se pidio guardar. */
  batchId: string | null;
};

/**
 * El oraculo del mes: veredicto sobre la cartera, reparto del efectivo de
 * bolsa entre las ideas que convencen (reserva para lo que no), y reparto del
 * efectivo cripto por el nucleo con el multiplicador de ciclo. Si `save`, se
 * registra todo como llamada para medirlo despues.
 */
export async function runMonthlyPlan(opts: {
  equityCash?: number | null;
  cryptoCash?: number | null;
  save?: boolean;
}): Promise<MonthlyPlan> {
  const settings = await resolveOracleSettings();
  const equityCash = opts.equityCash ?? settings.monthlyEquity;
  const cryptoCash = opts.cryptoCash ?? settings.monthlyCrypto;

  const run = await runConviction();

  // Lado bolsa: posiciones no cripto para los pesos; veredictos de esas
  // posiciones y de los candidatos de la watchlist (que entran con valor 0).
  const equityHoldings = run.holdings.filter((h) => h.assetClass !== "crypto");
  const cryptoSymbols = new Set(run.holdings.filter((h) => h.assetClass === "crypto").map((h) => h.symbol));
  const equityVerdicts = run.results.filter((r) => !cryptoSymbols.has(r.symbol));
  const equity = allocate({
    cash: equityCash,
    // El precio va tambien: sin el, un recorte no se puede expresar en acciones.
    holdings: equityHoldings.map((h) => ({ symbol: h.symbol, value: h.value, price: h.price })),
    verdicts: equityVerdicts,
    settings: {
      maxWeightPct: settings.maxWeightPct,
      minTicket: settings.minTicket,
      buyThreshold: settings.buyThreshold,
      reserveSymbol: settings.reserveSymbol,
    },
  });

  // Lado cripto: nucleo fijo escalado por ciclo. Datos mejor esfuerzo.
  const core = parseCore(settings.cryptoCore);
  const stats = new Map(
    await Promise.all(core.map(async (c) => [c.symbol, await cycleStatsFor(c.symbol).catch(() => null)] as const)),
  );
  const crypto = cryptoPlan(cryptoCash, core, stats);

  let batchId: string | null = null;
  if (opts.save) {
    const bySymbol = new Map([...run.candidates, ...run.holdings].map((h) => [h.symbol, h]));
    const amountBySymbol = new Map(equity.lines.map((l) => [l.symbol, l.amount]));
    const bench = bySymbol.get("VOO") ?? bySymbol.get("SPY") ?? null;
    batchId = await recordBatch({
      kind: "plan",
      items: run.results.map((r) => {
        const h = bySymbol.get(r.symbol);
        return {
          result: r,
          assetId: h?.assetId ?? null,
          assetClass: h?.assetClass ?? "equity",
          price: h && h.price > 0 ? h.price : null,
          planAmount: amountBySymbol.get(r.symbol) ?? null,
        };
      }),
      // El lado cripto se registra tambien: si no, la escalera no se puede
      // medir nunca y seria la unica parte del oraculo sin marcador.
      cycleItems: crypto.lines.map((l) => ({
        symbol: l.symbol,
        assetId: bySymbol.get(l.symbol)?.assetId ?? null,
        posture: l.posture,
        multiplier: l.multiplier,
        ladderMultiplier: l.ladderMultiplier,
        confirmed: l.confirmed,
        price: l.stats?.price ?? null,
        ath: l.stats?.ath ?? null,
        drawdownPct: l.stats?.drawdownPct ?? null,
        planAmount: l.amount,
        reason: l.reason,
      })),
      // Las apuestas de situacion especial tambien se registran, con su
      // propio kind, para conocer algun dia la tasa de acierto real.
      specialItems: (await specialCandidates().catch(() => []))
        .filter((r) => r.tier === "apuesta")
        .map((r) => {
          const h = bySymbol.get(r.symbol);
          return {
            symbol: r.symbol,
            assetId: h?.assetId ?? null,
            score: r.score,
            price: h && h.price > 0 ? h.price : null,
            planAmount: basketTicket(equity.totalBefore, 0) || null,
            reason: r.reason,
          };
        }),
      benchmark: bench ? { symbol: bench.symbol, assetId: bench.assetId, price: bench.price } : null,
    });
  }

  return { equity, crypto, settings, run, batchId };
}

/**
 * El plan es caro (EDGAR + Finnhub + FRED sobre toda la cartera y la
 * watchlist), asi que se memoiza y lo comparten todos los que lo necesitan:
 * "Que hacer" y el contexto del chat. Sin esto, abrir el chat volveria a
 * correr el oraculo entero y tardaria decenas de segundos.
 */
const PLAN_TTL_MS = 30 * 60_000;
let planMemo: { at: number; value: MonthlyPlan } | null = null;

/**
 * `save` deja el plan registrado en `conviction_calls`, que es el marcador del
 * oraculo: sin esas filas, `markForwardReturns` no tiene nada que marcar y no
 * se puede responder nunca si el motor acierta. Lo pide el reloj diario una
 * vez al dia; los demas (el chat, "Que hacer") leen y no guardan, para no
 * llenar el marcador de la misma llamada repetida cada vez que abres una
 * pantalla. Guardar no cuesta una corrida extra: es la misma que ya se hizo.
 */
export async function cachedMonthlyPlan(
  opts: { force?: boolean; save?: boolean } = {},
  now = Date.now(),
): Promise<MonthlyPlan> {
  if (!opts.force && planMemo && now - planMemo.at < PLAN_TTL_MS) return planMemo.value;
  const value = await runMonthlyPlan({ save: opts.save === true });
  planMemo = { at: now, value };
  return value;
}
