/**
 * Tests del asignador mensual (puro) y del modelo de ciclo cripto (puro):
 * reparto proporcional al atractivo, tope por posicion, ticket minimo,
 * cuadre exacto, reserva cuando nada convence; y multiplicadores de ciclo.
 * Correr con: npm run test:allocation
 */
import { allocate, attractiveness, targetWeights } from "../src/lib/allocation";
import { cryptoPlan, cycleMultiplier, cycleStats, parseCore } from "../src/lib/crypto-cycle";
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

function inRange(v: number | null | undefined, lo: number, hi: number, label: string) {
  checks++;
  if (v === null || v === undefined || v < lo || v > hi) {
    failures++;
    console.error(`  FALLO ${label}: ${v} no esta en [${lo}, ${hi}]`);
  } else {
    console.log(`  ok  ${label} (${v})`);
  }
}

function verdict(symbol: string, posture: Posture, score: number, mos: number | null = null): ConvictionResult {
  return {
    symbol,
    name: symbol,
    held: true,
    posture,
    score,
    confidence: 1,
    dataQuality: posture === "no_coverage" ? "insufficient" : "full",
    factors: [],
    fairValue: null,
    fairRange: null,
    valuationMethod: null,
    impliedGrowthPct: null,
    marginOfSafetyPct: mos,
    upsidePct: null,
    rationale: `${symbol} razon`,
    invalidation: null,
    caveats: [],
    asOf: 0,
  };
}

console.log("\n# attractiveness y targetWeights");
{
  truthy(attractiveness(70, 25) > attractiveness(70, 0), "el margen de seguridad inclina el atractivo");
  truthy(attractiveness(70, 500) === attractiveness(70, 50), "margen acotado a +50");
  const w = targetWeights([{ symbol: "A", a: 90 }, { symbol: "B", a: 10 }], 60);
  inRange(w.get("A"), 59.99, 60.01, "A recortada al tope 60%");
  inRange(w.get("B"), 39.99, 40.01, "B recibe el exceso");
  const both = targetWeights([{ symbol: "A", a: 90 }, { symbol: "B", a: 10 }], 15);
  inRange(both.get("A"), 14.99, 15.01, "con tope 15%, A al tope");
  inRange(both.get("B"), 14.99, 15.01, "y B tambien al tope (el resto de la cartera queda fuera)");
  const w2 = targetWeights([{ symbol: "A", a: 50 }, { symbol: "B", a: 50 }], 60);
  inRange(w2.get("A"), 49.99, 50.01, "sin tope tocado, proporcional");
}

console.log("\n# allocate: reparto basico con cuadre exacto");
{
  const plan = allocate({
    cash: 4000,
    holdings: [
      { symbol: "NVDA", value: 9000 },
      { symbol: "MSFT", value: 8000 },
      { symbol: "AMZN", value: 5000 },
      { symbol: "STX", value: 12000 },
      { symbol: "VOO", value: 20000 },
    ],
    verdicts: [
      verdict("NVDA", "buy", 78, 3),
      verdict("MSFT", "buy", 73, 20),
      verdict("AMZN", "buy", 72, 40),
      verdict("STX", "reduce", 71, -45),
      verdict("VOO", "no_coverage", 0),
    ],
    settings: { maxWeightPct: 25, minTicket: 500, buyThreshold: 64, reserveSymbol: "SGOV" },
  });
  const sum = plan.lines.reduce((s, l) => s + l.amount, 0) + plan.reserve;
  truthy(sum === 4000, `cuadre exacto: lineas + reserva = 4000 (${sum})`);
  truthy(plan.lines.length === 3, `tres lineas de compra (${plan.lines.map((l) => `${l.symbol} ${l.amount}`).join(", ")})`);
  truthy(plan.lines.every((l) => l.amount % 10 === 0), "importes redondeados a la decena");
  truthy(plan.lines.every((l) => l.weightAfter <= 25.01), "ninguna supera el tope tras el aporte");
  truthy(plan.trims.some((t) => t.symbol === "STX"), "STX aparece en recortes");
  truthy(plan.skipped.some((s) => s.symbol === "VOO"), "VOO sin cobertura queda fuera");
  // AMZN: menos peso y mas margen de seguridad -> mayor hueco -> mas dinero.
  const amzn = plan.lines.find((l) => l.symbol === "AMZN")!;
  const nvda = plan.lines.find((l) => l.symbol === "NVDA")!;
  truthy(amzn.amount >= nvda.amount, `la infraponderada con mas margen recibe mas (AMZN ${amzn.amount} >= NVDA ${nvda.amount})`);
  truthy(plan.lines.every((l) => l.reason.includes("conviccion")), "cada linea explica su razon");
}

console.log("\n# allocate: nada convence -> todo a reserva con razon");
{
  const plan = allocate({
    cash: 4000,
    holdings: [{ symbol: "A", value: 1000 }],
    verdicts: [verdict("A", "hold", 60), verdict("B", "reduce", 40)],
  });
  truthy(plan.lines.length === 0 && plan.reserve === 4000, "sin lineas, reserva completa");
  truthy(plan.reserveSymbol === "SGOV", "reserva en SGOV por defecto");
  truthy((plan.reserveReason ?? "").includes("umbral"), "explica que nada supera el umbral");
  truthy(plan.skipped.some((s) => s.symbol === "A" && s.reason.includes("mantener")), "mantener explicado");
}

console.log("\n# allocate: tope por posicion deja fuera a la que ya esta llena");
{
  const plan = allocate({
    cash: 2000,
    holdings: [
      { symbol: "FULL", value: 30000 },
      { symbol: "SMALL", value: 1000 },
      { symbol: "X", value: 69000 },
    ],
    verdicts: [verdict("FULL", "strong_buy", 85, 10), verdict("SMALL", "buy", 70, 10)],
    settings: { maxWeightPct: 15 },
  });
  truthy(!plan.lines.some((l) => l.symbol === "FULL"), "FULL (30% de peso) no recibe dinero");
  truthy(plan.skipped.some((s) => s.symbol === "FULL" && s.reason.includes("tope")), "razon: tope por posicion");
  truthy(plan.lines.some((l) => l.symbol === "SMALL" && l.amount === 2000), "SMALL recibe todo");
}

console.log("\n# allocate: ticket minimo");
{
  const plan = allocate({
    cash: 600,
    holdings: [],
    verdicts: [verdict("A", "buy", 80, 10), verdict("B", "buy", 70, 10), verdict("C", "buy", 66, 10)],
    settings: { minTicket: 500, maxWeightPct: 100 },
  });
  truthy(plan.lines.length === 1 && plan.lines[0].symbol === "A" && plan.lines[0].amount === 600, "con 600 y ticket 500, una sola linea en la mejor");
  const none = allocate({ cash: 300, holdings: [], verdicts: [verdict("A", "buy", 80)], settings: { minTicket: 500 } });
  truthy(none.lines.length === 0 && none.reserve === 300, "por debajo del ticket, todo a reserva");
}

console.log("\n# cripto: cycleStats y cycleMultiplier");
{
  const flat = Array.from({ length: 365 }, () => 100);
  const s = cycleStats(flat)!;
  inRange(s.distToMaPct, -0.01, 0.01, "plano: 0% sobre la media");
  truthy(cycleMultiplier(s).multiplier === 1, "plano -> 1x");

  const crash = [...Array.from({ length: 300 }, () => 100), ...Array.from({ length: 65 }, () => 45)];
  const sc = cycleStats(crash)!;
  inRange(sc.drawdownPct, -56, -54, "caida del 55% desde el maximo");
  truthy(cycleMultiplier(sc).multiplier === 1.5, "caida profunda -> 1.5x");

  const euphoria = [...Array.from({ length: 300 }, () => 100), ...Array.from({ length: 65 }, (_, i) => 100 + i * 2)];
  const se = cycleStats(euphoria)!;
  truthy((se.distToMaPct ?? 0) > 20, `sobreextendido: ${se.distToMaPct}% sobre la media`);
  truthy(cycleMultiplier(se).multiplier < 1, "sobreextendido -> menos de 1x");
  truthy(cycleMultiplier(null).multiplier === 1, "sin datos -> 1x");
  truthy(cycleStats([]) === null, "sin cierres -> null");
}

console.log("\n# cripto: parseCore y cryptoPlan");
{
  const core = parseCore("BTC:60, ETH:40");
  truthy(core.length === 2 && core[0].weightPct === 60 && core[1].weightPct === 40, "parsea y normaliza");
  truthy(parseCore("BTC:3,ETH:1")[0].weightPct === 75, "normaliza a 100");
  truthy(parseCore("basura").length === 0, "ignora entradas invalidas");

  const stats = new Map([
    ["BTC", cycleStats(Array.from({ length: 365 }, () => 100))],
    ["ETH", cycleStats([...Array.from({ length: 300 }, () => 100), ...Array.from({ length: 65 }, () => 45)])],
  ]);
  const plan = cryptoPlan(2500, core, stats);
  const btc = plan.lines.find((l) => l.symbol === "BTC")!;
  const eth = plan.lines.find((l) => l.symbol === "ETH")!;
  truthy(btc.amount === 1500 && btc.multiplier === 1, "BTC 60% a 1x = 1500");
  truthy(eth.amount === 1500 && eth.multiplier === 1.5, "ETH 40% a 1.5x = 1500");
  truthy(plan.reserve === 0 && plan.extra === 500, "pide 500 extra (no asume reserva)");
  const calm = cryptoPlan(2500, core, new Map([["BTC", stats.get("BTC")!], ["ETH", cycleStats([...Array.from({ length: 300 }, () => 100), ...Array.from({ length: 65 }, (_, i) => 100 + i * 2)])]]));
  truthy(calm.reserve > 0, `sobreextendido: parte queda en reserva (${calm.reserve})`);
}

console.log(`\n${failures === 0 ? "OK" : "FALLOS"}: ${checks - failures}/${checks} comprobaciones`);
process.exit(failures === 0 ? 0 : 1);
