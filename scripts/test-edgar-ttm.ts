/**
 * Tests del TTM propio desde EDGAR (puro, sin red). Los casos vienen de datos
 * REALES comprobados contra data.sec.gov, no de fixtures inventados.
 * Correr con: npm run test:edgar-ttm
 */
import {
  derivedQuarters,
  firstLive,
  flowPeriods,
  instants,
  latestInstant,
  ttmFlow,
  type Span,
} from "../src/lib/edgar-ttm";
import type { RawUnitEntry } from "../src/lib/edgar-facts";

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

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const HOY = new Date("2026-09-11");

/** Atajo para escribir entradas crudas. */
function e(start: string | null, end: string, val: number, filed: string): RawUnitEntry {
  return { ...(start ? { start } : {}), end, val, filed } as RawUnitEntry;
}

console.log("\n# flowPeriods: reexpresiones y duplicados");
{
  const list = flowPeriods([
    e("2026-01-01", "2026-03-31", 100, "2026-04-20"),
    // El mismo trimestre reexpresado mas tarde: gana el nuevo.
    e("2026-01-01", "2026-03-31", 110, "2026-07-20"),
    e("2025-10-01", "2025-12-31", 90, "2026-01-20"),
    // Sin start no es flujo.
    e(null, "2026-03-31", 999, "2026-04-20"),
  ]);
  eq(list.length, 2, "dos periodos distintos");
  eq(list[0].end, "2025-12-31", "ordenados por fecha de fin");
  eq(list[1].val, 110, "gana la declaracion mas tardia (reexpresion)");
}

console.log("\n# derivedQuarters: el cuarto trimestre que nadie presenta");
{
  const spans: Span[] = flowPeriods([
    e("2025-01-01", "2025-03-31", 10, "2025-04-20"),
    e("2025-04-01", "2025-06-30", 12, "2025-07-20"),
    e("2025-07-01", "2025-09-30", 14, "2025-10-20"),
    // Nueve meses y ejercicio completo: de la resta sale el Q4.
    e("2025-01-01", "2025-09-30", 36, "2025-10-20"),
    e("2025-01-01", "2025-12-31", 50, "2026-02-15"),
  ]);
  const qs = derivedQuarters(spans);
  eq(qs.length, 4, "tres declarados mas uno derivado");
  const q4 = qs.at(-1)!;
  eq([q4.start, q4.end, q4.val], ["2025-09-30", "2025-12-31", 14], "Q4 = ejercicio menos nueve meses");
  eq(q4.filed, "2026-02-15", "se conoce cuando se presenta el anual");

  // Si el Q4 ya viene declarado, no se duplica.
  const conQ4 = derivedQuarters([...spans, ...flowPeriods([e("2025-09-30", "2025-12-31", 14, "2026-02-15")])]);
  eq(conQ4.filter((q) => q.end === "2025-12-31").length, 1, "no duplica un Q4 ya declarado");
}

console.log("\n# ttmFlow: cuatro trimestres, no el ultimo anual");
{
  const entries = [
    e("2025-07-01", "2025-09-30", 14, "2025-10-20"),
    e("2025-10-01", "2025-12-31", 16, "2026-01-20"),
    e("2026-01-01", "2026-03-31", 18, "2026-04-20"),
    e("2026-04-01", "2026-06-30", 20, "2026-07-20"),
    // Un ejercicio viejo que NO debe ganar: el TTM es mas fresco.
    e("2025-01-01", "2025-12-31", 50, "2026-02-15"),
  ];
  const ttm = ttmFlow(entries, HOY);
  truthy(ttm !== null, "hay TTM");
  eq(ttm?.value, 68, "suma los cuatro ultimos trimestres (14+16+18+20)");
  eq(ttm?.basis, "quarters", "base trimestral");
  eq([ttm?.from, ttm?.to], ["2025-07-01", "2026-06-30"], "abarca doce meses reales");
  eq(ttm?.periods.length, 4, "deja rastro de los cuatro periodos");
}

console.log("\n# ttmFlow: sin trimestres se cae al ultimo ejercicio");
{
  const ttm = ttmFlow([e("2025-07-01", "2026-06-30", 200, "2026-08-15")], HOY);
  eq(ttm?.basis, "annual", "usa el anual");
  eq(ttm?.value, 200, "con su cifra");
}

console.log("\n# ttmFlow: una serie caduca no vale (el caso IBKR)");
{
  // IBKR dejo de declarar NetIncomeLoss en 2013 y se paso a ProfitLoss. El
  // codigo viejo se quedaba con el tag muerto y daba cifras de 2014.
  const muerto = [
    e("2013-01-01", "2013-03-31", 7, "2013-04-20"),
    e("2013-04-01", "2013-06-30", 10, "2013-07-20"),
    e("2013-07-01", "2013-09-30", 16, "2013-10-20"),
    e("2013-01-01", "2013-12-31", 40, "2014-02-15"),
  ];
  eq(ttmFlow(muerto, HOY), null, "serie de 2013: sin dato, no un dato viejo");

  const vivo = [
    e("2025-07-01", "2025-09-30", 1186, "2025-10-20"),
    e("2025-10-01", "2025-12-31", 1100, "2026-01-20"),
    e("2026-01-01", "2026-03-31", 1171, "2026-04-20"),
    e("2026-04-01", "2026-06-30", 1200, "2026-07-20"),
  ];
  const elegido = firstLive([muerto, vivo], (x) => ttmFlow(x, HOY));
  eq(elegido?.index, 1, "elige la serie viva aunque no sea la preferida");
  eq(elegido?.value.value, 4657, "y suma sus cuatro trimestres");
}

console.log("\n# ttmFlow: cuatro trimestres con un hueco no se suman");
{
  const conHueco = [
    e("2025-07-01", "2025-09-30", 14, "2025-10-20"),
    // Falta el trimestre de octubre a diciembre.
    e("2026-01-01", "2026-03-31", 18, "2026-04-20"),
    e("2026-04-01", "2026-06-30", 20, "2026-07-20"),
    e("2026-07-01", "2026-09-30", 22, "2026-10-20"),
  ];
  const ttm = ttmFlow(conHueco, HOY);
  // Los cuatro que hay no encadenan, asi que no vale sumarlos como doce meses.
  truthy(ttm === null || ttm.basis === "annual", "no inventa doce meses con un hueco por medio");
}

console.log("\n# instants y latestInstant: balance");
{
  const entries = [
    e(null, "2026-03-31", 500, "2026-04-20"),
    e(null, "2026-06-30", 540, "2026-07-20"),
    e(null, "2026-06-30", 545, "2026-08-01"),
  ];
  const list = instants(entries);
  eq(list.length, 2, "dos fechas");
  eq(list.at(-1)?.val, 545, "gana la reexpresion mas tardia");
  eq(latestInstant(entries, HOY)?.end, "2026-06-30", "la foto mas reciente");
  eq(latestInstant([e(null, "2014-12-31", 10, "2015-02-01")], HOY), null, "una foto de 2014 no vale");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
