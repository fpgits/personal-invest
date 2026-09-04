/**
 * Tests del modulo de fundamentales de EDGAR (puro, sin red): seleccion de
 * valores anuales desde XBRL, construccion de la tabla por ano, multiplos
 * calculados con precio y el texto para la IA.
 * Correr con: npm run test:edgar-facts
 */
import {
  buildFinancials,
  financialsToText,
  multiples,
  pickAnnual,
  type ConceptPoint,
  type RawUnitEntry,
} from "../src/lib/edgar-facts";

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
  if (!v) { failures++; console.error(`  FALLO ${label}`); } else { console.log(`  ok  ${label}`); }
}

console.log("\n# pickAnnual (XBRL → anual)");
{
  const entries: RawUnitEntry[] = [
    { start: "2024-01-01", end: "2024-12-31", val: 80e9, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-01" },
    { start: "2025-01-01", end: "2025-12-31", val: 90e9, fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01" },
    // restatement del mismo FY, declarado mas tarde → gana
    { start: "2025-01-01", end: "2025-12-31", val: 96.22e9, fy: 2025, fp: "FY", form: "10-K", filed: "2026-05-01" },
    // trimestre marcado FY (flujo corto) → se descarta
    { start: "2025-10-01", end: "2025-12-31", val: 25e9, fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01" },
    // 10-Q → se descarta
    { start: "2025-01-01", end: "2025-03-31", val: 22e9, fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-04-20" },
  ];
  eq(
    pickAnnual(entries),
    [{ fy: 2024, end: "2024-12-31", val: 80e9 }, { fy: 2025, end: "2025-12-31", val: 96.22e9 }],
    "un valor por FY, restatement mas reciente gana, trimestres y 10-Q fuera",
  );
  eq(pickAnnual(undefined), [], "sin datos → vacio");

  // Concepto de balance (sin start): se conserva.
  const balance: RawUnitEntry[] = [
    { end: "2025-12-31", val: 50e9, fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01" },
  ];
  eq(pickAnnual(balance), [{ fy: 2025, end: "2025-12-31", val: 50e9 }], "concepto de balance (sin start) se conserva");
}

console.log("\n# buildFinancials");
{
  const rev: ConceptPoint[] = [
    { fy: 2024, end: "2024-12-31", val: 80e9 },
    { fy: 2025, end: "2025-12-31", val: 96.22e9 },
  ];
  const ni: ConceptPoint[] = [{ fy: 2025, end: "2025-12-31", val: 24e9 }];
  const eps: ConceptPoint[] = [{ fy: 2025, end: "2025-12-31", val: 6.13 }];
  const eqy: ConceptPoint[] = [{ fy: 2025, end: "2025-12-31", val: 50e9 }];
  const view = buildFinancials({ revenue: rev, netIncome: ni, eps, equity: eqy, sharesOut: 15e9 }, 1000);

  eq(view.years.length, 2, "dos ejercicios");
  eq(view.available, true, "hay datos");
  const y25 = view.years[1];
  eq(y25.fy, 2025, "ultimo ano = 2025");
  eq(y25.netMargin, 24.9, "margen neto = beneficio/ingresos");
  eq(y25.revenueGrowth, 20.3, "crecimiento de ingresos a/a");
  eq(view.years[0].revenueGrowth, null, "sin ano previo no hay crecimiento");
  eq(view.sharesOut, 15e9, "acciones en circulacion");

  const empty = buildFinancials({ revenue: [], netIncome: [], eps: [], equity: [] }, 1);
  eq(empty.available, false, "sin nada → no disponible");

  // Recorta al maximo de anos.
  const many: ConceptPoint[] = Array.from({ length: 12 }, (_, i) => ({ fy: 2014 + i, end: "x", val: 100 + i }));
  eq(buildFinancials({ revenue: many, netIncome: [], eps: [], equity: [] }, 1, 8).years.length, 8, "recorta a maxYears");
}

console.log("\n# multiplos (con precio)");
{
  const view = buildFinancials(
    {
      revenue: [{ fy: 2025, end: "x", val: 96.22e9 }],
      netIncome: [{ fy: 2025, end: "x", val: 24e9 }],
      eps: [{ fy: 2025, end: "x", val: 6.13 }],
      equity: [{ fy: 2025, end: "x", val: 50e9 }],
      sharesOut: 15e9,
    },
    1,
  );
  const m = multiples(view, 228, 228 * 15e9);
  eq(m.pe, 37.2, "PER = precio / BPA");
  eq(m.ps, 35.5, "P/S = capitalizacion / ingresos");
  eq(m.pb, 68.4, "P/B = precio / valor contable por accion");

  eq(multiples(view, null, null), { pe: null, ps: null, pb: null }, "sin precio no hay multiplos");
  const noEps = buildFinancials({ revenue: [{ fy: 2025, end: "x", val: 1e9 }], netIncome: [], eps: [], equity: [] }, 1);
  eq(multiples(noEps, 100, 5e9).pe, null, "sin BPA no hay PER");
}

console.log("\n# financialsToText");
{
  const view = buildFinancials(
    {
      revenue: [{ fy: 2024, end: "x", val: 80e9 }, { fy: 2025, end: "x", val: 96.22e9 }],
      netIncome: [{ fy: 2025, end: "x", val: 24e9 }],
      eps: [{ fy: 2025, end: "x", val: 6.13 }],
      equity: [],
    },
    1,
  );
  const t = financialsToText(view);
  truthy(t.includes("SEC EDGAR"), "cita la fuente");
  truthy(t.includes("96.22B"), "formatea miles de millones");
  truthy(t.includes("+20.3% a/a"), "incluye crecimiento");
  truthy(t.includes("margen 24.9%"), "incluye margen");
  eq(financialsToText(buildFinancials({ revenue: [], netIncome: [], eps: [], equity: [] }, 1)), "", "sin datos → vacio");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
