/**
 * Tests del barrido del mercado (las partes puras, sin red ni base).
 * Correr con: npm run test:universe
 */
import { coverageFromView, yearsToSweep, DEFAULT_YEARS, REQUESTS_PER_SECOND } from "../src/lib/universe-run";
import { FRAME_CONCEPTS } from "../src/lib/edgar-frames";
import type { FinancialsView, FinancialYear } from "../src/lib/edgar-facts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FALLA  ${label}\n        esperado ${b}\n        recibido ${a}`);
  }
}
function truthy(cond: boolean, label: string) {
  checks++;
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FALLA  ${label}`);
  }
}

const AHORA = Date.parse("2026-09-14T00:00:00Z");
const year = (fy: number): FinancialYear =>
  ({ fy, end: `${fy}-12-31`, revenue: 100, netIncome: 10, netMargin: 10, eps: 1, equity: 50 }) as FinancialYear;
const view = (fys: number[]): FinancialsView => ({
  years: fys.map(year),
  sharesOut: 10,
  updatedAt: AHORA,
  available: fys.length > 0,
});

console.log("\n# que años se piden");
{
  const ys = yearsToSweep(AHORA);
  eq(ys.length, DEFAULT_YEARS, "ocho ejercicios");
  eq(ys.at(-1), 2025, "arranca en el anterior al corriente: 2026 aun no esta cerrado");
  eq(ys[0], 2018, "y llega ocho atras");
  truthy(ys.every((y, i) => i === 0 || y === ys[i - 1] + 1), "en orden ascendente, sin huecos");
  eq(yearsToSweep(AHORA, 3), [2023, 2024, 2025], "el numero de años es configurable");
}

console.log("\n# cuanto cuesta el barrido");
{
  const peticiones = FRAME_CONCEPTS.length * DEFAULT_YEARS;
  eq(peticiones, 144, "144 peticiones para ocho años de todo el mercado");
  const segundos = Math.ceil(peticiones / REQUESTS_PER_SECOND);
  truthy(segundos <= 60, `${segundos} s de descarga, dentro del cron de 300`);
  truthy(REQUESTS_PER_SECOND < 10, "por debajo del limite de la SEC, no justo encima");
}

console.log("\n# quien entra en el ranking y quien no");
{
  const ok = coverageFromView(view([2022, 2023, 2024, 2025]), 9, AHORA);
  truthy(ok.usable, "cuatro ejercicios recientes y nueve conceptos: entra");
  eq(ok.lastFy, 2025, "con su ultimo ejercicio apuntado");

  truthy(!coverageFromView(view([2024, 2025]), 9, AHORA).usable, "dos ejercicios no bastan");
  truthy(!coverageFromView(view([2022, 2023, 2024, 2025]), 3, AHORA).usable, "tres conceptos no bastan");
  truthy(
    !coverageFromView(view([2014, 2015, 2016]), 9, AHORA).usable,
    "unas cuentas congeladas en 2016 no describen 2026",
  );
  truthy(!coverageFromView(view([]), 0, AHORA).usable, "sin ejercicios no hay nada que valorar");

  // El limite exacto de frescura: tres años se aceptan, cuatro no. Sin esto la
  // frontera se mueve sola cada 1 de enero sin que nadie lo note.
  truthy(coverageFromView(view([2021, 2022, 2023]), 9, AHORA).usable, "ultimo ejercicio 2023: aun cuenta");
  truthy(!coverageFromView(view([2020, 2021, 2022]), 9, AHORA).usable, "ultimo ejercicio 2022: ya no");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
