/**
 * Tests del contexto macro (puro, sin red): parseo de observaciones de FRED,
 * derivados (spread de la curva, disponibilidad) y el texto para la IA.
 * Correr con: npm run test:macro
 */
import { firstValid, parseObservations } from "../src/lib/market/fred";
import { deriveMacro, macroToText, riskFreeRate } from "../src/lib/macro";

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

console.log("\n# Parseo de observaciones FRED");
{
  const raw = [
    { date: "2026-09-01", value: "." }, // dia sin dato
    { date: "2026-08-29", value: "4.23" },
    { date: "2026-08-28", value: "4.20" },
  ];
  eq(parseObservations(raw), [{ date: "2026-08-29", value: 4.23 }, { date: "2026-08-28", value: 4.2 }], "salta los '.' y parsea numeros");
  eq(parseObservations(undefined), [], "sin datos → vacio");
  eq(firstValid(raw), { date: "2026-08-29", value: 4.23 }, "primera valida en orden desc");
  eq(firstValid([{ date: "x", value: "." }]), null, "solo '.' → null");
}

console.log("\n# Derivados macro");
{
  const now = 1_000;
  const full = deriveMacro(
    { tenY: 4.23, twoY: 3.98, fedFunds: 4.33, inflationYoY: 2.9, unemployment: 4.1, asOf: "2026-08-29" },
    now,
  );
  eq(full.spread10y2y, 0.25, "spread = 10A - 2A");
  truthy(full.available, "hay datos → disponible");
  eq(full.updatedAt, now, "sella el momento");
  eq(riskFreeRate(full), 4.23, "tipo libre de riesgo = 10A");

  const inverted = deriveMacro(
    { tenY: 3.8, twoY: 4.5, fedFunds: null, inflationYoY: null, unemployment: null, asOf: null },
    now,
  );
  eq(inverted.spread10y2y, -0.7, "curva invertida (negativa)");
  truthy(inverted.available, "con solo tipos ya hay datos");

  const empty = deriveMacro(
    { tenY: null, twoY: null, fedFunds: null, inflationYoY: null, unemployment: null, asOf: null },
    now,
  );
  eq(empty.available, false, "sin nada → no disponible");
  eq(empty.spread10y2y, null, "sin tipos no hay spread");
  eq(riskFreeRate(empty), null, "sin 10A no hay tipo libre de riesgo");
}

console.log("\n# Texto para la IA");
{
  const now = 1;
  const m = deriveMacro(
    { tenY: 4.23, twoY: 3.98, fedFunds: 4.33, inflationYoY: 2.9, unemployment: 4.1, asOf: "2026-08-29" },
    now,
  );
  const t = macroToText(m);
  truthy(t.includes("Treasury 10A 4.23%"), "incluye el 10A");
  truthy(t.includes("curva 10-2 +0.25 pp"), "incluye la curva con signo");
  truthy(t.includes("Fed funds 4.33%") && t.includes("inflacion IPC 2.9%") && t.includes("desempleo 4.1%"), "incluye fed funds, inflacion y desempleo");

  const inv = macroToText(deriveMacro({ tenY: 3.8, twoY: 4.5, fedFunds: null, inflationYoY: null, unemployment: null, asOf: null }, now));
  truthy(inv.includes("(invertida)"), "marca la curva invertida");

  eq(macroToText(deriveMacro({ tenY: null, twoY: null, fedFunds: null, inflationYoY: null, unemployment: null, asOf: null }, now)), "", "sin datos → texto vacio (no ensucia el prompt)");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
