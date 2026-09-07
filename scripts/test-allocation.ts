/**
 * Tests del asignador mensual (puro) y del modelo de ciclo cripto (puro):
 * reparto proporcional al atractivo, tope por posicion, ticket minimo,
 * cuadre exacto, reserva cuando nada convence; y multiplicadores de ciclo.
 * Correr con: npm run test:allocation
 */
import { allocate, attractiveness, targetWeights } from "../src/lib/allocation";
import { cryptoPlan, cycleMultiplier, cycleStats, daysSinceNewLow, ladderFor, parseCore } from "../src/lib/crypto-cycle";
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

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
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

// Camino tipico de ciclo: sube a 126k, cae a 45k, y luego se queda plano.
function cyclePath(opts: { downTo?: number; flatDays?: number } = {}): number[] {
  const downTo = opts.downTo ?? 45000;
  const p: number[] = [];
  for (let i = 0; i < 500; i++) p.push(40000 + (126000 - 40000) * (i / 499));
  for (let i = 1; i <= 250; i++) p.push(126000 + (downTo - 126000) * (i / 250));
  for (let i = 0; i < (opts.flatDays ?? 0); i++) p.push(downTo);
  return p;
}

console.log("\n# cripto: cycleStats usa el maximo HISTORICO, no el del ano");
{
  const s = cycleStats(cyclePath({ flatDays: 30 }))!;
  inRange(s.ath, 125999, 126001, "maximo historico");
  inRange(s.drawdownPct, -64.5, -64, "caida desde el maximo historico");
  truthy(s.days > 500 && !s.shallowHistory, `historia larga (${s.days} dias)`);
  truthy((s.athDaysAgo ?? 0) > 250, "sabe hace cuanto fue el maximo");
  truthy(cycleStats([]) === null, "sin cierres -> null");
  const corto = cycleStats(Array.from({ length: 200 }, (_, i) => 100 + i))!;
  truthy(corto.shallowHistory, "menos de 2 anos se marca como historico corto");
}

console.log("\n# cripto: daysSinceNewLow (un precio plano NO es minimo nuevo)");
{
  const cayendo = cyclePath();
  eq(daysSinceNewLow(cayendo), 0, "el ultimo dia de la caida marca minimo nuevo");
  eq(daysSinceNewLow(cyclePath({ flatDays: 30 })), 30, "30 dias planos = 30 dias sin minimos nuevos");
  truthy(daysSinceNewLow(Array.from({ length: 50 }, () => 100)) === null, "sin historia suficiente -> null");
}

console.log("\n# cripto: escalera por profundidad");
{
  eq(ladderFor(-5).multiplier, 0.5, "a menos del 10% del maximo: aportar la mitad y guardar");
  eq(ladderFor(-20).multiplier, 1, "caida moderada: aporte normal");
  eq(ladderFor(-40).multiplier, 1.25, "-40% -> 1.25x");
  eq(ladderFor(-55).multiplier, 1.5, "-55% -> 1.5x");
  eq(ladderFor(-70).multiplier, 1.75, "-70% -> 1.75x");
  eq(ladderFor(-80).multiplier, 2, "-80% -> 2x");
}

console.log("\n# REGRESION: mientras siga cayendo NO se sube el aporte (no atrapar el cuchillo)");
{
  // El fallo original: de -31% a -65% el multiplicador solo subia. Ahora, con
  // minimos nuevos cada dia, se queda en aporte normal y guarda la reserva.
  const puntos = [650, 680, 710, 740];
  for (const d of puntos) {
    const s = cycleStats(cyclePath().slice(0, d))!;
    const dec = cycleMultiplier(s);
    truthy(
      dec.multiplier === 1 && !dec.confirmed,
      `dia ${d} (caida ${s.drawdownPct}%): aporte normal y tramo retenido (dio ${dec.multiplier}x, escalera pedia ${dec.ladderMultiplier}x)`,
    );
  }
  const hondo = cycleMultiplier(cycleStats(cyclePath().slice(0, 740))!);
  truthy(hondo.ladderMultiplier > 1 && hondo.reason.includes("mínimos nuevos"), "explica que espera a que pare la caida");
}

console.log("\n# REGRESION: un precio plano NO borra la caida (la ventana ya no es movil)");
{
  // El fallo original: plano en 45k durante un ano -> la caida "anual" pasaba
  // de -64% a 0% sin moverse el precio. Con el maximo historico, no.
  const s = cycleStats(cyclePath({ flatDays: 365 }))!;
  inRange(s.drawdownPct, -64.5, -64, "sigue a -64% del maximo despues de un ano plano");
  const dec = cycleMultiplier(s);
  truthy(dec.confirmed && dec.multiplier === 1.5, `al dejar de caer se suelta el tramo (${dec.multiplier}x)`);
}

console.log("\n# cripto: cerca del maximo se guarda munición");
{
  const casiMax = [...cyclePath().slice(0, 500), ...Array.from({ length: 120 }, () => 122000)];
  const dec = cycleMultiplier(cycleStats(casiMax)!);
  eq(dec.multiplier, 0.5, "a menos del 10% del maximo: medio aporte");
  truthy(dec.reason.includes("guardar reserva"), "y lo dice");
}

console.log("\n# cripto: parseCore y cryptoPlan");
{
  const core = parseCore("BTC:60, ETH:40");
  truthy(core.length === 2 && core[0].weightPct === 60 && core[1].weightPct === 40, "parsea y normaliza");
  truthy(parseCore("BTC:3,ETH:1")[0].weightPct === 75, "normaliza a 100");
  truthy(parseCore("basura").length === 0, "ignora entradas invalidas");

  const stats = new Map([
    ["BTC", cycleStats(cyclePath({ flatDays: 30 }))],      // -64%, ya no cae -> 1.5x
    ["ETH", cycleStats(cyclePath())],                       // -64%, sigue cayendo -> 1x retenido
  ]);
  const plan = cryptoPlan(2500, core, stats);
  const btc = plan.lines.find((l) => l.symbol === "BTC")!;
  const eth = plan.lines.find((l) => l.symbol === "ETH")!;
  eq(btc.amount, 2250, "BTC 60% x1.5 = 2250");
  eq(eth.amount, 1000, "ETH 40% x1 (retenido) = 1000");
  truthy(!eth.confirmed && eth.ladderMultiplier === 1.5, "ETH: la escalera pedia 1.5x pero esta retenida");
  truthy(plan.holding, "el plan avisa de que hay tramos retenidos");
  eq(plan.extra, 750, "pide 750 extra sobre el efectivo del mes");

  const tranquilo = cryptoPlan(2500, core, new Map([["BTC", null], ["ETH", null]]));
  truthy(tranquilo.lines.every((l) => l.multiplier === 1) && !tranquilo.holding, "sin datos: aporte normal");
}

console.log(`\n${failures === 0 ? "OK" : "FALLOS"}: ${checks - failures}/${checks} comprobaciones`);
process.exit(failures === 0 ? 0 : 1);
