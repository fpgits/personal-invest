import { allocate, type Plan } from "./allocation";
import { companyFinancials } from "./edgar-facts";
import { getFundamentalsMap } from "./fundamentals";
import { evaluate, rankResults, type ConvictionResult } from "./conviction";
import { recordBatch } from "./conviction-calls";
import { cryptoPlan, cycleStatsFor, parseCore, type CryptoPlan } from "./crypto-cycle";
import { getMacro, riskFreeRate } from "./macro";
import { computePortfolio } from "./portfolio";
import { resolveOracleSettings, type OracleSettings } from "./settings";
import { batched } from "./utils";

/**
 * Corre el motor de conviccion sobre la cartera real: junta posiciones, precios,
 * fundamentales de Finnhub, historico de EDGAR y el tipo libre de riesgo de FRED
 * y devuelve el veredicto ordenado por accionabilidad. Todo mejor esfuerzo: si
 * una fuente falla para un activo, se evalua con lo que haya y baja la confianza.
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
  const fmap = await getFundamentalsMap(
    positions.filter((p) => p.asset.assetClass !== "crypto").map((p) => p.asset.id),
  );

  // Concurrencia baja: EDGAR hace varias peticiones por empresa (limite ~10/s).
  const results = await batched(positions, 2, async (p) => {
    const a = p.asset;
    const fund = fmap.get(a.id) ?? null;
    let financials = null;
    if (a.assetClass !== "crypto" && a.cik) {
      financials = await companyFinancials(a.cik).catch(() => null);
    }
    return evaluate({
      symbol: a.symbol,
      name: a.name,
      assetClass: a.assetClass,
      price: p.price,
      fundamentals: fund?.metrics ?? null,
      earnings: fund?.earnings ?? [],
      financials,
      riskFreeRate: rf,
      position: { unrealizedPct: p.unrealizedPct, weight: p.weight },
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

  // Lado bolsa: solo lo que no es cripto cuenta para pesos y candidatas.
  const equityHoldings = run.holdings.filter((h) => h.assetClass !== "crypto");
  const equityVerdicts = run.results.filter((r) => equityHoldings.some((h) => h.symbol === r.symbol));
  const equity = allocate({
    cash: equityCash,
    holdings: equityHoldings.map((h) => ({ symbol: h.symbol, value: h.value })),
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
    const bySymbol = new Map(run.holdings.map((h) => [h.symbol, h]));
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
          price: h?.price ?? null,
          planAmount: amountBySymbol.get(r.symbol) ?? null,
        };
      }),
      benchmark: bench ? { symbol: bench.symbol, assetId: bench.assetId, price: bench.price } : null,
    });
  }

  return { equity, crypto, settings, run, batchId };
}
