/**
 * Test del periodo de revision, sin red ni DB:
 *  - resolucion de presets y comparaciones (bordes de mes, ano, bisiestos)
 *  - cookie: parseo tolerante y serializacion
 *  - etiquetas de rango
 *  - metricas del periodo desde snapshots + dividendos (parcial, en vivo,
 *    por grupo, movers, comparacion sin historico)
 * Correr con: npm run test:period
 */
process.env.TURSO_DATABASE_URL ||= "file:/tmp/period-test.db";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";

import type { Asset, Snapshot } from "../src/db/schema";
import {
  addDays,
  daysBetween,
  DEFAULT_SPEC,
  fmtRange,
  isIsoDate,
  parseSpec,
  periodBounds,
  resolvePeriod,
  resolveStored,
  serializeSpec,
  shiftMonths,
  startOfQuarter,
  todayLocal,
} from "../src/lib/period";
import { computePeriod, isReliableSnapshot, type DividendRow } from "../src/lib/period-metrics";
import type { PortfolioSummary, Position } from "../src/lib/portfolio";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function near(actual: number | null, expected: number, label: string, tol = 0.01) {
  checks++;
  if (actual === null || Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`  FALLO ${label}: esperado ~${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

// ---------------------------------------------------------------------------
console.log("1. Fechas y presets");
eq(addDays("2026-03-01", -1), "2026-02-28", "addDays cruza el mes");
eq(addDays("2024-02-28", 1), "2024-02-29", "bisiesto");
eq(daysBetween("2026-08-03", "2026-09-01"), 30, "30 dias incluidos");
eq(shiftMonths("2026-03-31", -1), "2026-02-28", "mes anterior sin dia 31 → ultimo dia");
eq(shiftMonths("2024-02-29", -12), "2023-02-28", "un ano atras desde bisiesto");
eq(startOfQuarter("2026-09-02"), "2026-07-01", "trimestre en curso");
eq(isIsoDate("2026-02-30"), false, "fecha inexistente no es ISO valida");
eq(isIsoDate("2026-2-3"), false, "formato corto no vale");
eq(isIsoDate("2026-02-03"), true, "ISO valida");
eq(todayLocal(new Date(2026, 8, 2, 23, 30)), "2026-09-02", "todayLocal usa el reloj local");

const T = "2026-09-02";
const r30 = resolvePeriod({ preset: "30d", comparison: "prev" }, T);
eq([r30.from, r30.to, r30.days], ["2026-08-04", "2026-09-02", 30], "ultimos 30 dias termina hoy");
eq([r30.cmpFrom, r30.cmpTo], ["2026-07-05", "2026-08-03"], "periodo anterior: los 30 dias justo antes");
eq(r30.label, "Ultimos 30 dias", "etiqueta del preset");
eq(r30.cmpLabel, "5 jul–3 ago 2026", "etiqueta de la comparacion");
const r1 = resolvePeriod({ preset: "1d", comparison: "prev" }, T);
eq([r1.from, r1.to, r1.cmpFrom, r1.cmpTo], [T, T, "2026-09-01", "2026-09-01"], "hoy vs ayer");
const ryd = resolvePeriod({ preset: "yd", comparison: "prev" }, T);
eq([ryd.from, ryd.to, ryd.cmpFrom, ryd.cmpTo, ryd.label], ["2026-09-01", "2026-09-01", "2026-08-31", "2026-08-31", "Ayer"], "ayer vs anteayer");
eq(resolvePeriod({ preset: "7d", comparison: "none" }, T).from, "2026-08-27", "ultimos 7 dias");
eq(resolvePeriod({ preset: "90d", comparison: "none" }, T).from, "2026-06-05", "ultimos 90 dias");
eq(resolvePeriod({ preset: "6m", comparison: "none" }, T).from, "2026-03-03", "ultimos 6 meses");
eq(resolvePeriod({ preset: "12m", comparison: "none" }, T).from, "2025-09-03", "ultimos 12 meses");
eq(resolvePeriod({ preset: "mtd", comparison: "none" }, T).from, "2026-09-01", "mes en curso");
eq(resolvePeriod({ preset: "qtd", comparison: "none" }, T).from, "2026-07-01", "trimestre en curso");
eq(resolvePeriod({ preset: "ytd", comparison: "none" }, T).from, "2026-01-01", "ano en curso");
const ry = resolvePeriod({ preset: "30d", comparison: "year" }, T);
eq([ry.cmpFrom, ry.cmpTo], ["2025-08-04", "2025-09-02"], "ano anterior: mismas fechas");
const rd = resolvePeriod({ preset: "30d", comparison: "year_dow" }, T);
eq([rd.cmpFrom, rd.cmpTo], ["2025-08-05", "2025-09-03"], "ano anterior por dia de la semana: 364 dias");
eq(new Date(`${rd.cmpFrom}T00:00:00Z`).getUTCDay(), new Date(`${r30.from}T00:00:00Z`).getUTCDay(), "mismo dia de la semana");
const rc = resolvePeriod({ preset: "custom", from: "2026-08-20", to: "2026-08-01", comparison: "custom", cmpFrom: "2026-06-01" }, T);
eq([rc.from, rc.to, rc.days], ["2026-08-01", "2026-08-20", 20], "personalizado ordena las fechas");
eq([rc.cmpFrom, rc.cmpTo], ["2026-06-01", "2026-06-20"], "comparacion personalizada dura lo mismo");
eq(rc.label, "1–20 ago 2026", "etiqueta de rango personalizado");
eq(resolvePeriod({ preset: "custom", from: "2026-09-10", to: "2026-09-20", comparison: "none" }, T).to, T, "un rango futuro se recorta a hoy");
eq(resolvePeriod({ preset: "custom", from: "2026-09-10", to: "2026-09-20", comparison: "none" }, T).from, T, "y el inicio no queda despues del fin");
eq(resolvePeriod({ preset: "custom", comparison: "custom" }, T).cmpFrom, null, "comparacion personalizada sin fecha → nada");

console.log("\n2. Cookie");
eq(parseSpec(undefined), DEFAULT_SPEC, "sin cookie → defecto");
eq(parseSpec("{no json"), DEFAULT_SPEC, "basura → defecto");
eq(parseSpec('{"preset":"99d","comparison":"x"}'), DEFAULT_SPEC, "valores desconocidos → defecto");
eq(parseSpec('{"preset":"custom","comparison":"prev"}'), DEFAULT_SPEC, "custom sin fechas → defecto");
eq(parseSpec('{"preset":"7d","comparison":"custom"}'), { preset: "7d", comparison: "none" }, "comparacion custom sin inicio → sin comparacion");
const spec = parseSpec(serializeSpec({ preset: "custom", from: "2026-08-01", to: "2026-08-20", comparison: "custom", cmpFrom: "2026-06-01", today: T }));
eq(spec, { preset: "custom", comparison: "custom", from: "2026-08-01", to: "2026-08-20", cmpFrom: "2026-06-01", today: T }, "ida y vuelta");
const stored = resolveStored({ preset: "30d", from: "2026-08-03", to: "2026-09-01", comparison: "prev", today: "2026-09-01" }, "2026-09-02");
eq([stored.from, stored.to, stored.label, stored.preset], ["2026-08-03", "2026-09-01", "Ultimos 30 dias", "30d"], "el servidor respeta las fechas del navegador");
eq(resolveStored({ preset: "30d", comparison: "prev" }, T).from, "2026-08-04", "sin fechas guardadas resuelve con hoy");
eq(periodBounds({ from: "2026-09-01", to: "2026-09-02" }), { fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 8, 2, 23, 59, 59, 999) }, "limites en ms, ambos dias incluidos");

console.log("\n3. Etiquetas");
eq(fmtRange("2026-09-02", "2026-09-02"), "2 sept 2026", "un dia");
eq(fmtRange("2026-08-03", "2026-08-20"), "3–20 ago 2026", "mismo mes");
eq(fmtRange("2026-07-04", "2026-08-02"), "4 jul–2 ago 2026", "mismo ano");
eq(fmtRange("2025-12-20", "2026-01-05"), "20 dic 2025–5 ene 2026", "cruza el ano");

// ---------------------------------------------------------------------------
console.log("\n4. Metricas del periodo");

const asset = (id: string, symbol: string, assetClass: string): Asset =>
  ({ id, symbol, name: symbol, assetClass, currency: "USD", providerId: symbol, logoUrl: null, cik: null, createdAt: 0 }) as Asset;

function position(a: Asset, quantity: number, price: number, costBasis: number, realized = 0, dividends = 0): Position {
  const value = quantity * price;
  return {
    asset: a, quantity, avgCost: quantity > 0 ? costBasis / quantity : 0, costBasis, price, value,
    unrealizedPnl: quantity > 0 ? value - costBasis : 0, unrealizedPct: 0, realizedPnl: realized, dividends, fees: 0,
    dayChange: 0, dayChangePct: 0, weight: 0, priceStale: false, priceUpdatedAt: null, costEstimated: false,
    group: a.assetClass === "cash" ? "equity" : a.assetClass,
  };
}

const AAPL = asset("a-aapl", "AAPL", "equity");
const BTC = asset("a-btc", "BTC", "crypto");
const USD = asset("a-usd", "USD", "cash");

function snap(date: string, opts: { aapl: number; btc: number; realizedEq?: number; realizedCr?: number; old?: boolean }): Snapshot {
  // 10 AAPL (coste 1000) + 0,1 BTC (coste 5000) + 500 USD.
  const aaplV = 10 * opts.aapl;
  const btcV = 0.1 * opts.btc;
  const positions = [
    { assetId: "a-aapl", symbol: "AAPL", assetClass: "equity", group: "equity", value: aaplV, quantity: 10, price: opts.aapl, weight: 0, unrealizedPnl: aaplV - 1000 },
    { assetId: "a-btc", symbol: "BTC", assetClass: "crypto", group: "crypto", value: btcV, quantity: 0.1, price: opts.btc, weight: 0, unrealizedPnl: btcV - 5000 },
    { assetId: "a-usd", symbol: "USD", assetClass: "cash", group: "equity", value: 500, quantity: 500, price: 1, weight: 0, unrealizedPnl: 0 },
  ];
  const byClass = [
    { assetClass: "equity", value: aaplV + 500, weight: 0, unrealizedPnl: aaplV - 1000, ...(opts.old ? {} : { realizedPnl: opts.realizedEq ?? 0, dividends: 0 }) },
    { assetClass: "crypto", value: btcV, weight: 0, unrealizedPnl: btcV - 5000, ...(opts.old ? {} : { realizedPnl: opts.realizedCr ?? 0, dividends: 0 }) },
  ];
  const realized = (opts.realizedEq ?? 0) + (opts.realizedCr ?? 0);
  return {
    id: `s-${date}`, date, totalValue: aaplV + btcV + 500, costBasis: 6500,
    unrealizedPnl: aaplV - 1000 + (btcV - 5000), realizedPnl: realized,
    breakdown: JSON.stringify({
      byClass,
      // Formato viejo: sin assetId, grupo ni clase.
      positions: opts.old ? positions.map((p) => ({ symbol: p.symbol, value: p.value, quantity: p.quantity, price: p.price, weight: 0 })) : positions,
    }),
    createdAt: 0,
  } as Snapshot;
}

function liveSummary(aapl: number, btc: number, realizedEq = 0): PortfolioSummary {
  const positions = [position(AAPL, 10, aapl, 1000, realizedEq), position(BTC, 0.1, btc, 5000), position(USD, 500, 1, 500)];
  const totalValue = positions.reduce((a, p) => a + p.value, 0);
  return {
    currency: "USD", totalValue, costBasis: 6500,
    unrealizedPnl: positions.reduce((a, p) => a + p.unrealizedPnl, 0), unrealizedPct: 0,
    realizedPnl: realizedEq, dividends: 0, fees: 0, dayChange: 0, dayChangePct: 0,
    positions, closed: [], byClass: [], degraded: false,
  };
}

// Historico: 29 ago → 1 sept. Hoy es 2 sept (en vivo).
const snaps = [
  snap("2026-08-29", { aapl: 100, btc: 60000 }),
  snap("2026-08-30", { aapl: 102, btc: 61000 }),
  snap("2026-08-31", { aapl: 105, btc: 59000, realizedEq: 50 }),
  snap("2026-09-01", { aapl: 104, btc: 62000, realizedEq: 50 }),
];
const live = liveSummary(110, 63000, 50);
const divs: DividendRow[] = [
  { assetClass: "equity", amount: 12, executedAt: Date.UTC(2026, 8, 1, 15) },
  { assetClass: "equity", amount: 99, executedAt: Date.UTC(2026, 7, 20, 15) }, // fuera del tramo medido
];

// "Hoy" (2 sept): parte del cierre del 1 sept, termina en vivo.
const hoy = computePeriod({ from: T, to: T }, "all", snaps.filter((s) => s.date < T), live, divs, T);
eq(hoy.start?.date, "2026-09-01", "hoy parte del cierre de ayer");
eq(hoy.end?.live, true, "hoy termina en vivo");
eq(hoy.partial, false, "hoy no es parcial");
// P&L ayer: (1040-1000)+(6200-5000)+50 = 1290. Hoy: (1100-1000)+(6300-5000)+50 = 1450. Δ = 160, sin dividendos hoy.
near(hoy.result, 160, "resultado de hoy = Δ P&L");
near(hoy.resultPct, (160 / (1040 + 6200 + 500)) * 100, "porcentaje sobre el valor de partida");
near(hoy.valueChange, 1100 + 6300 + 500 - (1040 + 6200 + 500), "variacion de valor");
eq(hoy.chart.map((p) => p.date), ["2026-09-01", "2026-09-02"], "grafico: partida + punto vivo");
near(hoy.chart[1].result, 160, "el punto vivo lleva el resultado relativo al inicio");
near(hoy.chart[0].result, 0, "el punto de partida arranca en 0");
near(hoy.chart[1].capital, 1100 + 6300 + 500 - (1450 + 111), "capital aportado = valor − P&L total (dividendos incluidos)");
eq(hoy.movers.map((m) => `${m.symbol}:${m.changePct.toFixed(2)}`), ["AAPL:5.77", "BTC:1.61"], "movers por variacion de precio, sin el efectivo");
near(hoy.movers[0].change, 10 * (110 - 104), "variacion en dinero con la cantidad actual");

// Ultimos 7 dias (27 ago → 2 sept): no hay cierre anterior al 27 → parcial desde el 29.
const week = computePeriod({ from: "2026-08-27", to: T }, "all", snaps, live, divs, T);
eq(week.partial, true, "sin cierre anterior: parcial");
eq(week.start?.date, "2026-08-29", "parte del primer cierre dentro");
// P&L 29 ago: (1000-1000)+(6000-5000)+0 = 1000. Hoy 1450. Δ 450 + dividendo del 1 sept (12) = 462.
near(week.result, 462, "resultado incluye el dividendo del tramo medido");
eq(week.dividends, 12, "el dividendo del 20 ago queda fuera");
eq(week.chart.length, 5, "grafico: 4 cierres + vivo");

// Rango pasado (30 ago → 31 ago), sin vivo.
const past = computePeriod({ from: "2026-08-30", to: "2026-08-31" }, "all", snaps, live, divs, T);
eq(past.start?.date, "2026-08-29", "rango pasado parte del cierre anterior");
eq([past.end?.date, past.end?.live], ["2026-08-31", false], "y termina en su ultimo cierre");
// P&L 29 ago: 1000. 31 ago: (1050-1000)+(5900-5000)+50 = 1000. Δ 0.
near(past.result, 0, "resultado de un rango pasado");
eq(past.movers.map((m) => `${m.symbol}:${m.changePct.toFixed(2)}`), ["AAPL:5.00", "BTC:-1.67"], "movers de un rango pasado con los precios del cierre");

// Sin historico (julio): nada.
const none = computePeriod({ from: "2026-07-01", to: "2026-07-31" }, "all", [], live, divs, T);
eq([none.start, none.end, none.result, none.chart.length, none.movers.length], [null, null, null, 0, 0], "sin snapshots no hay nada");

// Un solo cierre dentro y sin vivo: no hay tramo.
const single = computePeriod({ from: "2026-08-29", to: "2026-08-29" }, "all", [snaps[0]], null, divs, T);
eq([single.start?.date, single.end, single.result], ["2026-08-29", null, null], "un solo cierre no mide nada");

// Por grupo.
const bolsa = computePeriod({ from: T, to: T }, "bolsa", snaps, live, divs, T);
// Equity ayer: (1040-1000)+50 = 90; hoy: 100+50 = 150 → 60.
near(bolsa.result, 60, "resultado del lado bolsa");
eq(bolsa.movers.map((m) => m.symbol), ["AAPL"], "movers solo de bolsa");
near(bolsa.chart[0].capital, 1040 + 500 - (90 + 111), "capital aportado del lado bolsa");
const cripto = computePeriod({ from: T, to: T }, "cripto", snaps, live, divs, T);
near(cripto.result, 100, "resultado del lado cripto");
near(cripto.start?.value ?? null, 6200, "valor de partida del grupo");

// Snapshot viejo (sin realizado por clase): el grupo no se puede medir, el total si.
const oldSnaps = [snap("2026-09-01", { aapl: 104, btc: 62000, realizedEq: 50, old: true })];
const oldBolsa = computePeriod({ from: T, to: T }, "bolsa", oldSnaps, live, divs, T);
eq(oldBolsa.result, null, "grupo con snapshot viejo → sin resultado");
const oldAll = computePeriod({ from: T, to: T }, "all", oldSnaps, live, divs, T);
near(oldAll.result, 160, "el total si se mide con snapshots viejos");
eq(oldAll.movers.map((m) => m.symbol), ["AAPL", "BTC"], "movers por simbolo cuando no hay assetId");

// Un deposito entre dos cierres: el valor y el capital suben, el resultado no.
const dep = snap("2026-09-01", { aapl: 104, btc: 62000, realizedEq: 50 });
dep.totalValue += 5000; // llegan 5000 USD de efectivo
dep.breakdown = JSON.stringify({
  ...(JSON.parse(dep.breakdown) as object),
  positions: [...(JSON.parse(dep.breakdown) as { positions: unknown[] }).positions],
});
const depBefore = snap("2026-08-31", { aapl: 105, btc: 59000, realizedEq: 50 });
const depRange = computePeriod({ from: "2026-09-01", to: "2026-09-01" }, "all", [depBefore, dep], null, divs, T);
// P&L 31 ago: 1000; 1 sept: 1290 → 290 + dividendo (12) = 302: el deposito no cuenta.
near(depRange.result, 302, "un deposito no es resultado");
near(depRange.valueChange!, 5000 + (1040 + 6200 + 500) - (1050 + 5900 + 500), "el valor si sube con el deposito");
near(depRange.chart[1].capital! - depRange.chart[0].capital!, 5000 - 12, "el capital aportado absorbe el deposito (menos el dividendo cobrado)");

// Snapshots no fiables: vacios (cuenta recien creada) o con precios a 0.
const empty = { ...snap("2026-08-29", { aapl: 1, btc: 1 }), totalValue: 0, costBasis: 0, unrealizedPnl: 0, realizedPnl: 0, breakdown: JSON.stringify({ byClass: [], positions: [] }) } as Snapshot;
const broken = snap("2026-08-31", { aapl: 0, btc: 60000 }); // AAPL sin precio: P&L −1000
eq(isReliableSnapshot(empty), false, "snapshot vacio no es fiable");
eq(isReliableSnapshot(broken), false, "snapshot con un precio a 0 no es fiable");
eq(isReliableSnapshot(snaps[0]), true, "snapshot normal es fiable");
const dust = snap("2026-09-01", { aapl: 104, btc: 62000 });
dust.breakdown = JSON.stringify({
  ...(JSON.parse(dust.breakdown) as object),
  positions: [
    ...(JSON.parse(dust.breakdown) as { positions: object[] }).positions,
    { symbol: "LDFIL", value: 0, quantity: 0.0995, price: 0, weight: 0 },
  ],
});
eq(isReliableSnapshot(dust), true, "polvo sin cotizacion no invalida la foto");
const oldBroken = { ...broken, breakdown: JSON.stringify({ byClass: [{ assetClass: "equity", value: 500, weight: 0, unrealizedPnl: -1000 }, { assetClass: "crypto", value: 6000, weight: 0, unrealizedPnl: 1000 }], positions: [{ symbol: "AAPL", value: 0, quantity: 10, price: 0, weight: 0 }, { symbol: "USD", value: 500, quantity: 500, price: 1, weight: 0 }, { symbol: "BTC", value: 6000, quantity: 0.1, price: 60000, weight: 0 }] }) } as Snapshot;
eq(isReliableSnapshot(oldBroken), false, "formato viejo: un tercio de posiciones sin precio no es fiable");
const noisy = computePeriod({ from: "2026-08-27", to: T }, "all", [empty, broken, snaps[3]], live, divs, T);
eq(noisy.start?.date, "2026-09-01", "los no fiables se saltan: parte del primer cierre bueno");
near(noisy.result, 160, "y el resultado es solo el tramo fiable");
eq(noisy.chart.map((p) => p.date), ["2026-09-01", T], "el grafico tampoco los pinta");
const onlyBad = computePeriod({ from: "2026-08-27", to: "2026-08-31" }, "all", [empty, broken], null, divs, T);
eq([onlyBad.start, onlyBad.result, onlyBad.chart.length], [null, null, 0], "solo snapshots malos → nada, en vez de una cifra falsa");
// El cierre anterior fiable se busca hacia atras aunque haya malos en medio.
const skipBack = computePeriod({ from: "2026-09-01", to: "2026-09-01" }, "all", [snaps[1], broken, snaps[3]], null, divs, T);
eq(skipBack.start?.date, "2026-08-30", "salta el cierre roto y parte del anterior fiable");

// La comparacion de "hoy" (ayer) usa cierres, no el vivo.
const ayer = computePeriod({ from: "2026-09-01", to: "2026-09-01" }, "all", snaps, live, divs, T);
eq([ayer.start?.date, ayer.end?.date, ayer.end?.live], ["2026-08-31", "2026-09-01", false], "ayer: del cierre del 31 al del 1");
// P&L 31 ago: 1000; 1 sept: 1290 → 290 + 12 de dividendo.
near(ayer.result, 302, "resultado de ayer");

console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
if (failures > 0) {
  console.error(`${failures} fallos`);
  process.exit(1);
}
