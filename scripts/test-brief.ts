/**
 * Tests de "Que hacer" (puro, sin red): traduce veredicto, plan, eventos,
 * resultados proximos y propuestas pendientes a frases simples, y comprueba
 * que dice lo que los numeros dicen y nada mas.
 * Correr con: npm run test:brief
 */
import { buildBrief, type BriefInput } from "../src/lib/brief";
import type { ConvictionResult } from "../src/lib/conviction";
import type { Posture } from "../src/lib/conviction-labels";

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
function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const DAY = 86400_000;
const NOW = Date.parse("2026-09-06T12:00:00Z");

function verdict(symbol: string, posture: Posture, score: number, mos: number | null, upside: number | null, weakDetail?: string): ConvictionResult {
  return {
    symbol,
    name: symbol,
    held: true,
    posture,
    score,
    confidence: 1,
    dataQuality: posture === "no_coverage" ? "insufficient" : "full",
    factors: weakDetail
      ? [{ key: "valuation", label: "Valoracion", score: 25, weight: 0.28, detail: weakDetail }, { key: "quality", label: "Calidad / rentabilidad", score: 80, weight: 0.26, detail: "margen 30%" }]
      : [],
    fairValue: 100,
    fairRange: null,
    valuationMethod: "dcf",
    impliedGrowthPct: null,
    marginOfSafetyPct: mos,
    upsidePct: upside,
    rationale: "razon tecnica",
    invalidation: null,
    caveats: [],
    asOf: NOW,
  };
}

const base: BriefInput = {
  now: NOW,
  currency: "USD",
  results: [
    verdict("NVDA", "buy", 78, 3, 3),
    verdict("AMZN", "strong_buy", 80, 30, 43),
    verdict("STX", "reduce", 71, -90, -47, "PER 66"),
    verdict("TSLA", "sell", 28, -300, -97, "PER 352"),
    verdict("META", "hold", 69, 12, 14),
    verdict("AAPL", "hold", 67, -20, -18),
    verdict("VOO", "no_coverage", 0, null, null),
  ],
  holdings: ["NVDA", "AMZN", "STX", "TSLA", "META", "AAPL", "VOO"].map((s, i) => ({
    symbol: s,
    assetId: `a${i}`,
    assetClass: "equity",
    price: 100,
    value: 10_000,
    weight: 14,
  })),
  plan: {
    equity: {
      cash: 4000,
      totalBefore: 70_000,
      totalAfter: 74_000,
      lines: [
        { symbol: "AMZN", amount: 2500, score: 80, posture: "strong_buy", marginOfSafetyPct: 30, weightBefore: 13.5, weightAfter: 16.9, reason: "r" },
        { symbol: "NVDA", amount: 1500, score: 78, posture: "buy", marginOfSafetyPct: 3, weightBefore: 13.5, weightAfter: 15.5, reason: "r" },
      ],
      reserve: 0,
      reserveSymbol: "SGOV",
      reserveReason: null,
      trims: [],
      skipped: [],
    },
    crypto: {
      cash: 2500,
      lines: [
        { symbol: "BTC", amount: 1500, base: 1500, multiplier: 1, reason: "precio cerca de su media: aporte normal", stats: null },
        { symbol: "ETH", amount: 800, base: 1000, multiplier: 0.8, reason: "25% por encima de la media de 200 dias: aportar algo menos", stats: null },
      ],
      reserve: 200,
      extra: 0,
    },
  },
  events: [
    { id: "e1", headline: "Insiders de STX venden $3M", priority: "P2", thesisImpact: -25, occurredAt: NOW - 2 * DAY, companies: '["STX"]', signalScore: 70 },
    { id: "e2", headline: "Compra agrupada de insiders en NVDA", priority: "P2", thesisImpact: 35, occurredAt: NOW - 1 * DAY, companies: '["NVDA"]', signalScore: 72 },
    { id: "e3", headline: "Ruido viejo", priority: "P2", thesisImpact: -30, occurredAt: NOW - 20 * DAY, companies: '["AAPL"]', signalScore: 66 },
    { id: "e4", headline: "Cosa menor", priority: "P3", thesisImpact: 5, occurredAt: NOW - 1 * DAY, companies: '["META"]', signalScore: 52 },
  ],
  earnings: [
    { symbol: "META", at: NOW + 10 * DAY },
    { symbol: "NVDA", at: NOW + 60 * DAY },
    { symbol: "ZZZ", at: NOW + 3 * DAY },
  ],
  pendingProposals: 2,
};

console.log("\n# esta semana");
{
  const b = buildBrief(base);
  const actions = b.week.items.map((i) => `${i.action}:${i.symbol ?? "-"}`);
  truthy(actions.includes("vender:TSLA"), `vende TSLA (${actions.join(" ")})`);
  truthy(actions.includes("reducir:STX"), "reduce STX");
  truthy(actions.includes("comprar:AMZN"), "AMZN en zona de compra (30% de descuento)");
  truthy(!actions.includes("comprar:NVDA"), "NVDA (3%) no es oportunidad de la semana");
  truthy(actions.includes("revisar:STX") && actions.includes("buena_senal:NVDA"), "eventos de la semana con impacto");
  truthy(!b.week.items.some((i) => i.title === "Ruido viejo"), "evento de hace 20 dias fuera");
  truthy(!b.week.items.some((i) => i.title === "Cosa menor"), "evento de poco impacto fuera");
  truthy(b.week.items.some((i) => i.title.includes("2 propuestas")), "propuestas pendientes");
  const tsla = b.week.items.find((i) => i.symbol === "TSLA" && i.action === "vender")!;
  truthy(tsla.why.includes("97%") && tsla.why.includes("PER 352"), `porque de la venta legible: ${tsla.why}`);
  const stx = b.week.items.find((i) => i.symbol === "STX" && i.action === "reducir")!;
  truthy(stx.why.includes("47%") && stx.why.includes("Toma beneficios"), "porque del recorte: caro, toma beneficios");
  truthy(b.week.headline.includes("1 venta") && b.week.headline.includes("1 recorte"), `titular de la semana: ${b.week.headline}`);
  truthy(!/P[1-5]|score|tier/i.test(JSON.stringify(b.week)), "sin jerga en la semana");
}

console.log("\n# este mes");
{
  const b = buildBrief(base);
  truthy(b.month.headline.includes("AMZN $2.500") && b.month.headline.includes("NVDA $1.500"), `titular del mes: ${b.month.headline}`);
  eq(b.month.equity.lines.map((l) => l.symbol), ["AMZN", "NVDA"], "lineas de compra");
  truthy(b.month.equity.lines[0].why.includes("excelente") && b.month.equity.lines[0].why.includes("30%"), "AMZN: excelente y con descuento");
  truthy(b.month.equity.lines[0].why.includes("del 14% al 17%"), "peso antes → despues en lenguaje llano");
  truthy(b.month.crypto.lines[1].why.includes("Menos de lo habitual"), "ETH: menos de lo habitual por ciclo");
  eq(b.month.crypto.reserve, 200, "reserva cripto");
  truthy(b.summary.includes("Este mes: 2 compras por $4.000 y $2.500 a cripto"), `resumen: ${b.summary}`);
}

console.log("\n# vigilar");
{
  const b = buildBrief(base);
  const items = b.watch.items.map((i) => `${i.action}:${i.symbol}`);
  truthy(items.includes("esperar:META"), "resultados de META en 10 dias");
  truthy(!items.includes("esperar:NVDA"), "resultados a 60 dias no se avisan aun");
  truthy(!items.includes("esperar:ZZZ"), "resultados de algo que no tienes, fuera");
  truthy(items.includes("vigilar:META"), "META se acerca a zona de compra (12%)");
  truthy(items.includes("vigilar:AAPL"), "AAPL se pone caro (-18%)");
  truthy(!items.some((i) => i.endsWith(":VOO")), "sin cobertura no aparece");
}

console.log("\n# semana tranquila");
{
  const quiet = buildBrief({
    ...base,
    results: [verdict("NVDA", "buy", 78, 3, 3)],
    events: [],
    pendingProposals: 0,
    earnings: [],
  });
  eq(quiet.week.items.length, 0, "sin items");
  truthy(quiet.week.headline.includes("no hay nada urgente"), `titular tranquilo: ${quiet.week.headline}`);
  const noBuys = buildBrief({ ...quiet && base, results: [verdict("NVDA", "hold", 60, 0, 0)], events: [], pendingProposals: 0, earnings: [], plan: { ...base.plan, equity: { ...base.plan.equity, lines: [], reserve: 4000, reserveReason: "Nada supera el umbral" } } });
  truthy(noBuys.month.headline.includes("no compres nada en bolsa") && noBuys.month.headline.includes("SGOV"), `mes sin compras: ${noBuys.month.headline}`);
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
