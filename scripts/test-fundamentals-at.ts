/**
 * Tests de la foto de fundamentales "tal como se conocían" (puro, sin red).
 * La regla que se comprueba una y otra vez: en la fecha D solo cuenta lo que
 * ya estaba PRESENTADO en la SEC antes de D. Mirar el 10-K de febrero desde
 * diciembre es hacer trampa, y esa trampa es la que arruina cualquier intento
 * de "aprender del pasado".
 * Correr con: npm run test:fundamentals-at
 */
import { asOf, drawdownAt, priceAt, priorAnnual, snapshotAt } from "../src/lib/fundamentals-at";
import type { RawUnitEntry } from "../src/lib/edgar-facts";
import type { DailyClose } from "../src/lib/market/stooq";

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

// Ingresos anuales de una empresa con cierre en diciembre, presentados en
// febrero del año siguiente, como GoPro.
const fy = (fy: number, val: number, filed: string): RawUnitEntry => ({
  start: `${fy}-01-01`,
  end: `${fy}-12-31`,
  val,
  fy,
  fp: "FY",
  form: "10-K",
  filed,
});
// Un trimestre suelto (10-Q), que NO debe colarse como flujo anual.
const q = (fy: number, quarter: number, val: number, filed: string): RawUnitEntry => ({
  start: `${fy}-${String(quarter * 3 - 2).padStart(2, "0")}-01`,
  end: `${fy}-${String(quarter * 3).padStart(2, "0")}-30`,
  val,
  fy,
  fp: `Q${quarter}`,
  form: "10-Q",
  filed,
});
// Un instante (balance), que sí viene en los 10-Q.
const inst = (end: string, val: number, filed: string, form = "10-Q"): RawUnitEntry => ({ end, val, filed, form });

const REVENUE = [
  fy(2023, 1005e6, "2024-02-15"),
  fy(2024, 801e6, "2025-02-14"),
  fy(2025, 560e6, "2026-02-13"),
  q(2026, 1, 99e6, "2026-05-08"),
  q(2026, 2, 105e6, "2026-08-07"),
];

console.log("\n# sin mirar al futuro: manda la fecha de presentación");
{
  // En diciembre de 2025 el 10-K de 2025 aún no existe: se ve el de 2024.
  const dec = asOf(REVENUE, "2025-12-31", "flow")!;
  eq(dec.val, 801e6, "el 31 dic 2025 los últimos ingresos anuales conocidos son los de 2024");
  eq(dec.filed, "2025-02-14", "presentados en febrero de 2025");
  // Un día después de presentar el 10-K de 2025, ya cuenta.
  eq(asOf(REVENUE, "2026-02-13", "flow")!.val, 560e6, "el mismo día de la presentación ya se ve");
  eq(asOf(REVENUE, "2026-02-12", "flow")!.val, 801e6, "y el día anterior todavía no");
  // Los trimestres no valen como flujo anual.
  eq(asOf(REVENUE, "2026-08-31", "flow")!.val, 560e6, "un 10-Q no sustituye al anual en las cifras de flujo");
  eq(asOf(REVENUE, "2023-06-01", "flow"), null, "antes del primer informe no hay nada, no se inventa");
  eq(asOf(undefined, "2026-01-01", "flow"), null, "sin concepto, null");
}

console.log("\n# crecimiento contra el ejercicio anterior, también sin trampa");
{
  const cur = asOf(REVENUE, "2026-03-01", "flow")!;
  const prev = priorAnnual(REVENUE, cur, "2026-03-01")!;
  eq([cur.val, prev.val], [560e6, 801e6], "actual 2025, anterior 2024");
  // Si el anterior aún no estaba presentado en la fecha (caso raro), no se usa.
  const late = [fy(2024, 801e6, "2026-06-01"), fy(2025, 560e6, "2026-02-13")];
  const c2 = asOf(late, "2026-03-01", "flow")!;
  eq(priorAnnual(late, c2, "2026-03-01"), null, "un anterior presentado DESPUÉS de la fecha no cuenta");
}

console.log("\n# balance: el último informe presentado, sea anual o trimestral");
{
  const CASH = [
    inst("2025-12-31", 90e6, "2026-02-13", "10-K"),
    inst("2026-03-31", 55e6, "2026-05-08"),
    inst("2026-06-30", 27.3e6, "2026-08-07"),
  ];
  eq(asOf(CASH, "2026-06-01", "instant")!.val, 55e6, "en junio se conoce la caja de marzo (10-Q de mayo)");
  eq(asOf(CASH, "2026-08-10", "instant")!.val, 27.3e6, "en agosto, la de junio");
  eq(asOf(CASH, "2026-08-06", "instant")!.val, 55e6, "el día antes del 10-Q, todavía la de marzo");
}

console.log("\n# precio y caída desde el máximo de cinco años, a la fecha");
{
  const prices: DailyClose[] = [
    { date: "2021-09-01", close: 12 },
    { date: "2022-09-01", close: 6 },
    { date: "2024-09-02", close: 2 },
    { date: "2026-02-10", close: 0.7 },
    { date: "2026-02-12", close: 0.68 },
    { date: "2026-09-04", close: 1.69 },
  ];
  eq(priceAt(prices, "2026-02-11")!.close, 0.7, "el último cierre anterior o igual a la fecha");
  eq(priceAt(prices, "2021-01-01"), null, "antes del primer dato no hay precio");
  const dd = drawdownAt(prices, "2026-02-12")!;
  eq(dd.high, 12, "máximo de los cinco años anteriores");
  truthy(dd.drawdownPct < -94, `caída del ${dd.drawdownPct}%`);
  // El salto de septiembre no puede contaminar una foto de febrero.
  truthy(drawdownAt(prices, "2026-02-12")!.highDate === "2021-09-01", "el máximo posterior a la fecha no existe todavía");
}

console.log("\n# la foto completa de GoPro en febrero de 2026 (seis meses antes del salto)");
{
  const prices: DailyClose[] = [
    { date: "2021-09-01", close: 12 },
    { date: "2025-12-31", close: 1.1 },
    { date: "2026-03-05", close: 0.9 },
    { date: "2026-08-20", close: 0.66 },
  ];
  const raw = {
    revenue: REVENUE,
    netIncome: [fy(2024, -432e6, "2025-02-14"), fy(2025, -180e6, "2026-02-13")],
    ocf: [fy(2025, -60e6, "2026-02-13")],
    capex: [fy(2025, 8e6, "2026-02-13")],
    cash: [inst("2025-12-31", 90e6, "2026-02-13", "10-K"), inst("2026-06-30", 27.3e6, "2026-08-07")],
    debt: [inst("2025-12-31", 87e6, "2026-02-13", "10-K")],
    equity: [inst("2025-12-31", 40e6, "2026-02-13", "10-K")],
    sharesOut: [inst("2026-02-01", 160e6, "2026-02-13", "10-K"), inst("2026-08-07", 184.5e6, "2026-08-07")],
  };
  const s = snapshotAt("GPRO", "2026-03-05", raw, prices);
  eq(s.price, 0.9, "precio del día");
  eq(s.sharesOut, 160e6, "acciones del 10-K de febrero, no las 184,5M de agosto");
  eq(s.marketCap, 144e6, "capitalización = precio x acciones conocidas");
  eq(s.revenue, 560e6, "ingresos de 2025 (ya presentados)");
  eq(s.revenueGrowthPct, -30.1, "cayendo un 30% frente a 2024");
  eq(s.netMarginPct, -32.1, "margen neto muy negativo");
  eq(s.fcf, -68e6, "FCF = caja operativa menos capex");
  eq(s.cash, 90e6, "caja del 10-K, no los 27M de junio que aún no existían");
  eq(s.netDebt, -3e6, "deuda neta casi cero en febrero");
  eq(s.ps, 0.26, "precio/ventas 0,26: el mercado la valora en un cuarto de una venta anual");
  truthy(s.pb !== null && s.pb > 3, `P/B ${s.pb} (patrimonio pequeño)`);
  truthy(s.drawdownPct !== null && s.drawdownPct < -90, `${s.drawdownPct}% desde el máximo de 5 años`);
  eq(s.asOf.flowsFiled, "2026-02-13", "y dice de qué informe salen los flujos");
  eq(s.asOf.balanceEnd, "2025-12-31", "y de qué fecha es el balance");

  // La misma empresa vista en agosto: ya con el 10-Q de junio.
  const aug = snapshotAt("GPRO", "2026-08-20", raw, prices);
  eq(aug.cash, 27.3e6, "en agosto sí se ve la caja de junio");
  eq(aug.sharesOut, 184.5e6, "y las acciones nuevas");
  eq(aug.revenue, 560e6, "pero los ingresos anuales siguen siendo los de 2025");
  truthy(aug.marketCap !== null && aug.marketCap < 125e6, `capitalización ~$${Math.round(aug.marketCap! / 1e6)}M`);
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
