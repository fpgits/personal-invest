/**
 * Tests del motor de conviccion (puro, sin red ni IA): interpolacion,
 * metricas derivadas del historico, y el veredicto en casos claros
 * (compounder de calidad, cara y floja, cripto, posicion sobrevalorada).
 * Correr con: npm run test:conviction
 */
import {
  buyUpsideBar,
  cashConversion,
  confidenceOf,
  evaluate,
  fairValue,
  fcfPerShare,
  growthEstimate,
  lerp,
  marginTrend,
  normalizedEps,
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

function eqS(actual: unknown, expected: unknown, label: string) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${String(expected)}, obtenido ${String(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
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
      // Con flujo de caja: asi el valor razonable tiene las DOS patas, que es
      // el caso normal desde que EDGAR trae bien el capex.
      { fy: 2022, revenue: 140, netIncome: 35, netMargin: 25, eps: 5.2, equity: 110, revenueGrowth: 15, ocf: 40, capex: 10, fcf: 30, shares: 6.73 },
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
  eqS(r.valuationMethod, "blend", "valor razonable con dos patas");
  inRange(r.confidence, 0.99, 1, "confianza plena: cobertura total y nada fragil");
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
      { fy: 2022, revenue: 126, netIncome: 28, netMargin: 22, eps: 2.0, equity: 72, revenueGrowth: 12, ocf: 30, capex: 8, fcf: 22, shares: 14 },
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

console.log("\n# una sola pata: el mismo caro, sin flujo de caja, no se recorta igual");
{
  // Identico al anterior pero SIN datos de caja: el valor razonable sale solo
  // del multiplo. Una estimacion mas fragil no manda vender: se mantiene.
  const input: ConvictionInput = {
    symbol: "RICHTHIN", assetClass: "equity", price: 100, riskFreeRate: 4.2,
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
  eqS(r.valuationMethod, "pe", "una sola pata");
  eqP(r.posture, "hold", "no recorta con un numero fragil (umbral -65 en vez de -45)");
  truthy(r.confidence < 0.9, `confianza rebajada por fragilidad (${r.confidence})`);
  truthy(
    r.caveats.some((c) => c.includes("una sola pata")),
    "lo dice en voz alta",
  );
}

console.log("\n# comprar exige margen cuando el valor tiene una sola pata");
{
  eqS(buyUpsideBar(2), -10, "con dos patas se tolera pagar un 10% de mas");
  eqS(buyUpsideBar(1), 10, "con una sola pata hace falta un 10% a favor");
  eqS(buyUpsideBar(0), 10, "sin valoracion, la barra no se puede saltar");
}

console.log("\n# fuentes que se contradicen: el caso NVDA");
{
  // Numeros reales de sept 2026: el proveedor daba PER 28,1 con la accion a
  // $218 (BPA TTM implicito $7,76) mientras el ultimo 10-K declaraba 29.760 M$
  // entre 24.940 M de acciones = $1,19 por accion. Seis veces y media.
  const input: ConvictionInput = {
    symbol: "NVDA", assetClass: "equity", price: 218.05, riskFreeRate: 4.8,
    position: { unrealizedPct: -4, weight: 8 },
    fundamentals: {
      ...EMPTY_METRICS, marketCap: 1090000, pe: 28.1, ps: 17.9, pb: 20.8,
      revenueGrowthYoy: 83.4, epsGrowthYoy: 125.2, operatingMargin: 65.2, netMargin: 63.7,
      roe: 110.1, debtToEquity: 0.38, currentRatio: 4.4,
    },
    financials: financials([
      { fy: 2023, revenue: 16675, netIncome: 4332, netMargin: 26, eps: 1.73, equity: 12204, revenueGrowth: 52.7 },
      { fy: 2024, revenue: 26914, netIncome: 9752, netMargin: 36.2, eps: 3.85, equity: 16893, revenueGrowth: 61.4 },
      { fy: 2025, revenue: 26974, netIncome: 4368, netMargin: 16.2, eps: 0.17, equity: 26612, revenueGrowth: 0.2 },
      { fy: 2026, revenue: 60922, netIncome: 29760, netMargin: 48.8, eps: 1.19, equity: 22101, revenueGrowth: 125.8, ocf: 28090, capex: 1069, fcf: 27021, shares: 24940 },
    ]),
  };
  const r = evaluate(input);
  eqS(r.fairValue, null, "no publica un valor razonable inventado");
  truthy(r.posture !== "buy" && r.posture !== "strong_buy", `y no dice comprar (${r.posture})`);
  truthy(r.confidence <= 0.65, `confianza baja, no 100% (${r.confidence})`);
  truthy(
    r.caveats.some((c) => c.includes("no cuadran")),
    "explica que las fuentes se contradicen",
  );

  // Con el BPA del proveedor coherente con el 10-K, si valora.
  const ok = evaluate({ ...input, fundamentals: { ...input.fundamentals!, pe: 150 } });
  truthy(ok.fairValue !== null, "con fuentes coherentes vuelve a haber valor razonable");
}

console.log("\n# normalizedEps: el pico de ciclo muerde aunque el PER tope");
{
  const peak = { flagged: true, severity: 0.5, current: 60, median: 30, streak: 0 };
  eqS(normalizedEps(10, peak), 7.5, "severidad 0,5 lleva el BPA a medio camino de la mediana");
  eqS(normalizedEps(10, { ...peak, severity: 1 }), 5, "severidad 1 lo lleva entero a la mediana");
  eqS(normalizedEps(10, { ...peak, severity: 0 }), 10, "sin severidad no toca nada");
  eqS(normalizedEps(10, { ...peak, flagged: false, severity: 0.8 }), 10, "sin pico marcado no toca nada");
  eqS(normalizedEps(10, { ...peak, current: 20, median: 30 }), 10, "margen por debajo de la mediana no se normaliza");

  // El fallo que motivo el cambio: con crecimiento alto el PER se pega al
  // techo y recortar la prima no cambiaba NADA. Ahora el pico si mueve.
  const base: ConvictionInput = {
    symbol: "PEAKY", assetClass: "equity", price: 200, riskFreeRate: 4.8,
    fundamentals: {
      ...EMPTY_METRICS, pe: 28, revenueGrowthYoy: 80, epsGrowthYoy: 120, netMargin: 60, grossMargin: 75,
    },
    financials: financials([
      { fy: 2021, revenue: 100, netIncome: 20, netMargin: 20, eps: 2 },
      { fy: 2022, revenue: 120, netIncome: 30, netMargin: 25, eps: 2.5 },
      { fy: 2023, revenue: 130, netIncome: 26, netMargin: 20, eps: 2.2 },
      { fy: 2024, revenue: 200, netIncome: 120, netMargin: 60, eps: 7.1 },
    ]),
  };
  const withPeak = fairValue(base);
  const noPeak = fairValue({
    ...base,
    fundamentals: { ...base.fundamentals!, netMargin: 22 },
  });
  truthy(
    withPeak.value !== null && noPeak.value !== null && withPeak.value < noPeak.value,
    `el pico rebaja el valor razonable (${withPeak.value} < ${noPeak.value})`,
  );
}

console.log("\n# confianza: cobertura menos fragilidad");
{
  const full = { coverage: 1, legs: 2 as const, peakSeverity: 0, edgar: true, earningsOk: true, epsMismatch: false };
  eqS(confidenceOf(full), 1, "todo solido: 1");
  eqS(confidenceOf({ ...full, legs: 1 }), 0.85, "una sola pata: -0,15");
  eqS(confidenceOf({ ...full, legs: 0 }), 0.75, "sin valoracion: -0,25");
  eqS(confidenceOf({ ...full, epsMismatch: true }), 0.65, "fuentes contradictorias: -0,35");
  eqS(confidenceOf({ ...full, edgar: false }), 0.85, "sin historico EDGAR: -0,15");
  eqS(confidenceOf({ ...full, peakSeverity: 1 }), 0.9, "pico de ciclo pleno: -0,10");
  eqS(confidenceOf({ ...full, coverage: 0.6, legs: 1, edgar: false }), 0.3, "los castigos se acumulan");
  truthy(confidenceOf({ coverage: 0, legs: 0, peakSeverity: 1, edgar: false, earningsOk: false, epsMismatch: true }) >= 0.1, "nunca baja de 0,1");
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
  truthy(r.valuationMethod === "blend", `valora por DCF + multiplo (${r.valuationMethod})`);
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
  truthy(pk.severity > 0.5, `severidad alta con margen 35% sobre mediana 8.3% (${pk.severity})`);
  truthy(!r.caveats.some((c) => c.includes("escenario bajista")), "ya no dice que el DCF va al caso bajista");
}

console.log("\n# margen que mejora ano tras ano NO es pico: es cambio estructural");
{
  // El caso real que rompia el modelo: Amazon con AWS y publicidad, Netflix
  // tras subir precios. Sube seis anos seguidos, con un bache por medio.
  const structural: ConvictionInput = {
    symbol: "GROW", assetClass: "equity", price: 100, riskFreeRate: 4.0,
    fundamentals: { ...EMPTY_METRICS, pe: 21, netMargin: 17.4, grossMargin: 48, roe: 25, revenueGrowthYoy: 16 },
    financials: financials([
      { fy: 2019, revenue: 100, netIncome: 4.1, netMargin: 4.1 },
      { fy: 2020, revenue: 120, netIncome: 6.6, netMargin: 5.5 },
      { fy: 2021, revenue: 145, netIncome: 10.3, netMargin: 7.1 },
      { fy: 2022, revenue: 160, netIncome: -0.8, netMargin: -0.5 },
      { fy: 2023, revenue: 180, netIncome: 9.5, netMargin: 5.3 },
      { fy: 2024, revenue: 210, netIncome: 19.5, netMargin: 9.3 },
    ]),
  };
  const pk = peakCycle(structural);
  truthy(pk.streak === 3, `detecta 3 anos seguidos de mejora (${pk.streak})`);
  truthy(!pk.flagged, `no lo marca como pico pese a estar ${Math.round(pk.current! / pk.median!)}x sobre la mediana`);
  truthy(pk.severity === 0, `y por tanto no penaliza nada (${pk.severity})`);
  const r = evaluate(structural);
  truthy(
    r.caveats.some((c) => c.includes("cambio estructural")),
    "pero lo dice en voz alta, por si el margen revierte",
  );

  // Un diente de sierra de verdad (memoria, semis) SIGUE marcandose.
  const cyclical: ConvictionInput = {
    ...structural,
    symbol: "SAW",
    fundamentals: { ...structural.fundamentals!, netMargin: 40 },
    financials: financials([
      { fy: 2020, revenue: 100, netIncome: 10, netMargin: 10 },
      { fy: 2021, revenue: 130, netIncome: 58, netMargin: 45 },
      { fy: 2022, revenue: 110, netIncome: 9, netMargin: 8 },
      { fy: 2023, revenue: 120, netIncome: 14, netMargin: 12 },
      { fy: 2024, revenue: 150, netIncome: 60, netMargin: 40 },
    ]),
  };
  const saw = peakCycle(cyclical);
  truthy(saw.flagged, `el diente de sierra sigue marcandose (racha ${saw.streak}a)`);
  truthy(saw.severity === 1, `y con severidad maxima (${saw.severity})`);
}

console.log("\n# la severidad es gradual, no un interruptor");
{
  const mk = (margin: number, hist: number[]): ConvictionInput => ({
    symbol: "SEV", assetClass: "equity", price: 100, riskFreeRate: 4.0,
    fundamentals: { ...EMPTY_METRICS, pe: 15, netMargin: margin, grossMargin: 60, roe: 20, revenueGrowthYoy: 12 },
    financials: financials(hist.map((m, i) => ({ fy: 2020 + i, revenue: 100, netIncome: m, netMargin: m }))),
  });
  // Diente de sierra en todos los casos; solo cambia cuanto sobresale el actual.
  const saw = [10, 30, 9, 12];
  const leve = peakCycle(mk(22, saw));
  const medio = peakCycle(mk(28, saw));
  const fuerte = peakCycle(mk(40, saw));
  truthy(leve.severity < medio.severity && medio.severity < fuerte.severity, `severidad creciente: ${leve.severity} < ${medio.severity} < ${fuerte.severity}`);
  truthy(fuerte.severity === 1, `topa en 1 (${fuerte.severity})`);
  truthy(leve.severity > 0 && leve.severity < 1, `un pico leve no recibe el castigo entero (${leve.severity})`);
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
