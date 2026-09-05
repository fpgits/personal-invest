/**
 * Tests del motor de conviccion (puro, sin red ni IA): interpolacion,
 * metricas derivadas del historico, y el veredicto en casos claros
 * (compounder de calidad, cara y floja, cripto, posicion sobrevalorada).
 * Correr con: npm run test:conviction
 */
import {
  cashConversion,
  evaluate,
  fairValue,
  fcfPerShare,
  growthEstimate,
  lerp,
  marginTrend,
  peakCycle,
  rankResults,
  revenueCagr,
  sharesTrend,
  POSTURE_RANK,
  type ConvictionInput,
  type Posture,
} from "../src/lib/conviction";
import type { FinancialsView, FinancialYear } from "../src/lib/edgar-facts";
import type { FundamentalMetrics } from "../src/lib/market/finnhub";

let failures = 0;
let checks = 0;

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function inRange(v: number | null, lo: number, hi: number, label: string) {
  checks++;
  if (v === null || v < lo || v > hi) {
    failures++;
    console.error(`  FALLO ${label}: ${v} no esta en [${lo}, ${hi}]`);
  } else {
    console.log(`  ok  ${label} (${v})`);
  }
}

function eqP(actual: Posture, expected: Posture, label: string) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const EMPTY_METRICS: FundamentalMetrics = {
  marketCap: null, pe: null, ps: null, pb: null, beta: null,
  revenueGrowthYoy: null, epsGrowthYoy: null, grossMargin: null,
  operatingMargin: null, netMargin: null, roe: null, debtToEquity: null,
  currentRatio: null, dividendYield: null, high52: null, low52: null,
};

function financials(rows: Array<Partial<FinancialYear> & { fy: number }>, sharesOut = 1e9): FinancialsView {
  const years: FinancialYear[] = rows.map((r) => ({
    fy: r.fy,
    revenue: r.revenue ?? null,
    netIncome: r.netIncome ?? null,
    netMargin: r.netMargin ?? null,
    eps: r.eps ?? null,
    equity: r.equity ?? null,
    revenueGrowth: r.revenueGrowth ?? null,
    ocf: r.ocf ?? null,
    capex: r.capex ?? null,
    fcf: r.fcf ?? null,
    fcfMargin: r.fcfMargin ?? null,
    debt: r.debt ?? null,
    cash: r.cash ?? null,
    netDebt: r.netDebt ?? null,
    shares: r.shares ?? null,
  }));
  return { years, sharesOut, updatedAt: 0, available: years.some((y) => y.revenue !== null) };
}

console.log("\n# lerp (interpolacion por tramos)");
{
  truthy(lerp(-5, [[0, 40], [10, 60]]) === 40, "acota por debajo");
  truthy(lerp(20, [[0, 40], [10, 60]]) === 60, "acota por arriba");
  truthy(lerp(5, [[0, 40], [10, 60]]) === 50, "punto medio");
}

console.log("\n# metricas derivadas del historico");
{
  const fv = financials([
    { fy: 2020, revenue: 100, netIncome: 10, netMargin: 10 },
    { fy: 2021, revenue: 120, netIncome: 15, netMargin: 12.5 },
    { fy: 2022, revenue: 150, netIncome: 24, netMargin: 16 },
  ]);
  // CAGR 100 -> 150 en 2 pasos = ~22.5%.
  inRange(revenueCagr(fv), 20, 25, "revenueCagr");
  // Margen 10 -> 16 subiendo: pendiente positiva.
  truthy((marginTrend(fv) ?? 0) > 0, "marginTrend positivo cuando el margen mejora");
  truthy(revenueCagr(financials([{ fy: 2022, revenue: 100 }])) === null, "CAGR null con un solo ano");
}

console.log("\n# growthEstimate (combina EDGAR + Finnhub, acotado)");
{
  const input: ConvictionInput = {
    symbol: "X", assetClass: "equity", price: 100, riskFreeRate: 4.2,
    fundamentals: { ...EMPTY_METRICS, revenueGrowthYoy: 18, epsGrowthYoy: 20 },
    financials: financials([
      { fy: 2020, revenue: 100 }, { fy: 2021, revenue: 115 }, { fy: 2022, revenue: 132 },
    ]),
  };
  inRange(growthEstimate(input), 14, 20, "mediana de crecimientos");
  const wild: ConvictionInput = {
    ...input,
    fundamentals: { ...EMPTY_METRICS, revenueGrowthYoy: 500, epsGrowthYoy: 400 },
  };
  inRange(growthEstimate(wild), 0, 60, "acota crecimientos absurdos");
}

console.log("\n# veredicto: compounder de calidad a precio razonable -> comprar");
{
  const input: ConvictionInput = {
    symbol: "GOOD", name: "Buena Co", assetClass: "equity", price: 100, riskFreeRate: 4.2,
    fundamentals: {
      ...EMPTY_METRICS, marketCap: 500000, pe: 22, ps: 6, pb: 8,
      revenueGrowthYoy: 18, epsGrowthYoy: 20, operatingMargin: 30, netMargin: 25,
      roe: 30, debtToEquity: 0.4, currentRatio: 1.8, low52: 70,
    },
    financials: financials([
      { fy: 2019, revenue: 90, netIncome: 18, netMargin: 20, eps: 3.4, equity: 60, revenueGrowth: 12 },
      { fy: 2020, revenue: 105, netIncome: 22, netMargin: 21, eps: 3.9, equity: 72, revenueGrowth: 16 },
      { fy: 2021, revenue: 122, netIncome: 28, netMargin: 23, eps: 4.6, equity: 88, revenueGrowth: 16 },
      { fy: 2022, revenue: 140, netIncome: 35, netMargin: 25, eps: 5.2, equity: 110, revenueGrowth: 15 },
    ]),
    earnings: [
      { period: "2022-Q4", actual: 1.4, estimate: 1.3, surprisePct: 7.7 },
      { period: "2022-Q3", actual: 1.3, estimate: 1.25, surprisePct: 4 },
    ],
  };
  const r = evaluate(input);
  inRange(r.score, 64, 100, "score alto");
  truthy(r.posture === "buy" || r.posture === "strong_buy", `postura de compra (${r.posture})`);
  truthy(r.dataQuality === "full", "dataQuality full");
  inRange(r.confidence, 0.99, 1, "confianza plena (todos los factores)");
  truthy(r.fairValue !== null && r.fairValue > 0, "valor razonable calculado");
  truthy(r.factors.every((f) => f.score !== null), "todos los factores puntuados");
  truthy(r.rationale.length > 10, "rationale no vacio");
  truthy(r.invalidation !== null, "invalidacion definida");
}

console.log("\n# veredicto: cara y de baja calidad -> evitar");
{
  const input: ConvictionInput = {
    symbol: "PRICEY", assetClass: "equity", price: 100, riskFreeRate: 4.2,
    fundamentals: {
      ...EMPTY_METRICS, marketCap: 200000, pe: 95, ps: 30, pb: 18,
      revenueGrowthYoy: 3, epsGrowthYoy: -5, operatingMargin: 4, netMargin: 3,
      roe: 4, debtToEquity: 3, currentRatio: 0.9,
    },
    financials: financials([
      { fy: 2020, revenue: 100, netIncome: 4, netMargin: 4, eps: 0.4, equity: 20, revenueGrowth: 2 },
      { fy: 2021, revenue: 103, netIncome: 3, netMargin: 2.9, eps: 0.3, equity: 19, revenueGrowth: 3 },
      { fy: 2022, revenue: 106, netIncome: 3, netMargin: 2.8, eps: 0.3, equity: 18, revenueGrowth: 3 },
    ]),
  };
  const r = evaluate(input);
  inRange(r.score, 0, 48, "score bajo");
  truthy(r.posture === "avoid" || r.posture === "hold", `postura defensiva (${r.posture})`);
}

console.log("\n# veredicto: cripto -> sin cobertura");
{
  const r = evaluate({
    symbol: "BTC", assetClass: "crypto", price: 60000, riskFreeRate: 4.2,
    fundamentals: null, financials: null,
  });
  eqP(r.posture, "no_coverage", "cripto sin cobertura fundamental");
  truthy(r.score === 0 && r.factors.length === 0, "sin factores");
}

console.log("\n# veredicto: sin fundamentales -> sin cobertura");
{
  const r = evaluate({
    symbol: "OBSCURE", assetClass: "equity", price: 10, riskFreeRate: 4.2,
    fundamentals: null, financials: null,
  });
  eqP(r.posture, "no_coverage", "equity sin datos");
}

console.log("\n# posicion en cartera, buen negocio pero muy caro -> reducir");
{
  const input: ConvictionInput = {
    symbol: "RICHHELD", assetClass: "equity", price: 100, riskFreeRate: 4.2,
    position: { unrealizedPct: 140, weight: 12 },
    fundamentals: {
      ...EMPTY_METRICS, marketCap: 800000, pe: 55, ps: 18, pb: 20,
      revenueGrowthYoy: 12, epsGrowthYoy: 14, operatingMargin: 28, netMargin: 22,
      roe: 26, debtToEquity: 0.5, currentRatio: 1.6, low52: 60,
    },
    financials: financials([
      { fy: 2020, revenue: 100, netIncome: 20, netMargin: 20, eps: 1.6, equity: 50, revenueGrowth: 11 },
      { fy: 2021, revenue: 112, netIncome: 24, netMargin: 21, eps: 1.8, equity: 60, revenueGrowth: 12 },
      { fy: 2022, revenue: 126, netIncome: 28, netMargin: 22, eps: 2.0, equity: 72, revenueGrowth: 12 },
    ]),
  };
  const r = evaluate(input);
  truthy(r.held, "marcada como en cartera");
  truthy(r.upsidePct !== null && r.upsidePct < -20, `sobrevalorada (upside ${r.upsidePct}%)`);
  truthy(
    POSTURE_RANK[r.posture] <= POSTURE_RANK.reduce,
    `postura de recorte o venta (${r.posture})`,
  );
}

console.log("\n# fairValue y ranking");
{
  const fv = fairValue({
    symbol: "V", assetClass: "equity", price: 100, riskFreeRate: 4.0,
    fundamentals: { ...EMPTY_METRICS, pe: 20, revenueGrowthYoy: 15 },
    financials: financials([{ fy: 2022, revenue: 100, eps: 5 }]),
  });
  truthy(fv.value !== null && fv.value > 0, "valor razonable positivo");
  truthy(fv.justifiedPe !== null && fv.justifiedPe >= 8 && fv.justifiedPe <= 40, "PER justificado acotado");

  const ranked = rankResults([
    evaluate({ symbol: "A", assetClass: "crypto", price: 1, riskFreeRate: 4, fundamentals: null, financials: null }),
    evaluate({
      symbol: "B", assetClass: "equity", price: 100, riskFreeRate: 4.2,
      fundamentals: {
        ...EMPTY_METRICS, pe: 18, ps: 4, pb: 5, revenueGrowthYoy: 20, epsGrowthYoy: 22,
        netMargin: 26, roe: 32, operatingMargin: 30, debtToEquity: 0.3, currentRatio: 2,
      },
      financials: financials([
        { fy: 2021, revenue: 100, netIncome: 24, netMargin: 24, eps: 4, equity: 50, revenueGrowth: 18 },
        { fy: 2022, revenue: 120, netIncome: 31, netMargin: 26, eps: 5, equity: 65, revenueGrowth: 20 },
        { fy: 2023, revenue: 145, netIncome: 38, netMargin: 26, eps: 6, equity: 85, revenueGrowth: 21 },
      ]),
    }),
  ]);
  truthy(ranked[0].symbol === "B", "el de compra queda primero, cripto al final");
}

console.log("\n# FCF: valor razonable por DCF, rango y crecimiento implicito");
{
  // 1.000M de FCF con 100M de acciones = 10 de FCF/accion; precio 200.
  const input: ConvictionInput = {
    symbol: "CASHCOW", assetClass: "equity", price: 200, riskFreeRate: 4.0,
    fundamentals: {
      ...EMPTY_METRICS, pe: 25, ps: 5, pb: 6, beta: 1.0,
      revenueGrowthYoy: 12, epsGrowthYoy: 14, operatingMargin: 30, netMargin: 22,
      grossMargin: 60, roe: 28, debtToEquity: 0.3, currentRatio: 1.8,
    },
    financials: financials([
      { fy: 2020, revenue: 3000e6, netIncome: 600e6, netMargin: 20, ocf: 900e6, capex: 100e6, fcf: 800e6, debt: 500e6, cash: 900e6, netDebt: -400e6, shares: 110e6, revenueGrowth: 10 },
      { fy: 2021, revenue: 3400e6, netIncome: 700e6, netMargin: 20.6, ocf: 1000e6, capex: 110e6, fcf: 890e6, debt: 500e6, cash: 1000e6, netDebt: -500e6, shares: 106e6, revenueGrowth: 13 },
      { fy: 2022, revenue: 3800e6, netIncome: 800e6, netMargin: 21, ocf: 1100e6, capex: 100e6, fcf: 1000e6, debt: 500e6, cash: 1200e6, netDebt: -700e6, shares: 100e6, revenueGrowth: 12 },
    ], 100e6),
  };
  inRange(fcfPerShare(input.financials), 9.9, 10.1, "FCF por accion");
  const r = evaluate(input);
  truthy(r.valuationMethod === "dcf", `valora por DCF (${r.valuationMethod})`);
  truthy(r.fairRange !== null && r.fairRange.bear < r.fairRange.base && r.fairRange.base < r.fairRange.bull, "rango bajista < base < alcista");
  truthy(r.impliedGrowthPct !== null, `crecimiento implicito calculado (${r.impliedGrowthPct}%)`);
  truthy(r.marginOfSafetyPct !== null, `margen de seguridad calculado (${r.marginOfSafetyPct}%)`);
  truthy(r.factors.find((f) => f.key === "valuation")!.detail.includes("rend. FCF"), "valoracion usa rendimiento FCF");
  truthy(r.factors.find((f) => f.key === "strength")!.detail.includes("caja neta"), "solidez detecta caja neta");
  truthy(r.factors.find((f) => f.key === "consistency")!.detail.includes("recompras"), "consistencia detecta recompras");
  truthy(r.rationale.includes("descuenta"), "la razon incluye el DCF inverso");
  inRange(cashConversion(input.financials), 1.3, 1.4, "conversion a caja OCF/beneficio");
  inRange(sharesTrend(input.financials), -9.5, -8.5, "recompras ~-9%");
}

console.log("\n# pico de ciclo: margen actual muy por encima de su historia -> aviso y recorte");
{
  const base: ConvictionInput = {
    symbol: "CYCLE", assetClass: "equity", price: 100, riskFreeRate: 4.0,
    fundamentals: { ...EMPTY_METRICS, pe: 12, netMargin: 35, grossMargin: 48, roe: 60, revenueGrowthYoy: 30 },
    financials: financials([
      { fy: 2019, revenue: 100, netIncome: 8, netMargin: 8 },
      { fy: 2020, revenue: 95, netIncome: 5, netMargin: 5.3 },
      { fy: 2021, revenue: 110, netIncome: 12, netMargin: 10.9 },
      { fy: 2022, revenue: 120, netIncome: 10, netMargin: 8.3 },
      { fy: 2023, revenue: 160, netIncome: 56, netMargin: 35 },
    ]),
  };
  const pk = peakCycle(base);
  truthy(pk.flagged, `pico detectado (actual ${pk.current}% vs mediana ${pk.median}%)`);
  const r = evaluate(base);
  truthy(r.caveats.some((c) => c.includes("pico de ciclo")), "aviso de pico de ciclo");
  const calm = evaluate({ ...base, fundamentals: { ...base.fundamentals!, netMargin: 9 } });
  truthy(!peakCycle({ ...base, fundamentals: { ...base.fundamentals!, netMargin: 9 } }).flagged, "sin pico con margen normal");
  truthy(r.factors.find((f) => f.key === "valuation")!.score! < calm.factors.find((f) => f.key === "valuation")!.score!, "valoracion recortada en pico");
}

console.log("\n# beneficio que no se convierte en caja -> aviso");
{
  const r = evaluate({
    symbol: "PAPER", assetClass: "equity", price: 50, riskFreeRate: 4.0,
    fundamentals: { ...EMPTY_METRICS, pe: 15, netMargin: 12, grossMargin: 40, roe: 14, revenueGrowthYoy: 6 },
    financials: financials([
      { fy: 2022, revenue: 1000, netIncome: 120, netMargin: 12, ocf: 40, capex: 10, fcf: 30 },
    ]),
  });
  truthy(r.caveats.some((c) => c.includes("se convierte en caja")), "aviso de baja conversion a caja");
}

console.log(`\n${failures === 0 ? "OK" : "FALLOS"}: ${checks - failures}/${checks} comprobaciones`);
process.exit(failures === 0 ? 0 : 1);
