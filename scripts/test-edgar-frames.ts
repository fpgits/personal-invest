/**
 * Tests de la ingesta por frames (puro, sin red).
 * Correr con: npm run test:edgar-frames
 *
 * Las formas de las respuestas estan copiadas de peticiones reales a la SEC
 * hechas el 14/09/2026, incluido el detalle que mas duele si se ignora: un
 * saldo pedido sin la I de instantaneo devuelve 404.
 */
import {
  cikKey,
  financialsFromFrames,
  frameUrl,
  namesFromFrames,
  pivotFrames,
  requestPlan,
  FRAME_CONCEPTS,
  type Frame,
} from "../src/lib/edgar-frames";

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

const AHORA = Date.parse("2026-06-30T00:00:00Z");
const frame = (rows: Array<[number, string, number, string?]>): Frame => ({
  data: rows.map(([cik, end, val, name]) => ({ cik, end, val, entityName: name })),
});

console.log("\n# la URL distingue flujo de saldo");
{
  const rev = FRAME_CONCEPTS.find((c) => c.tag === "Revenues")!;
  const eq2 = FRAME_CONCEPTS.find((c) => c.tag === "StockholdersEquity")!;
  const eps = FRAME_CONCEPTS.find((c) => c.tag === "EarningsPerShareDiluted")!;
  eq(frameUrl(rev, 2024), "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2024.json", "un flujo va sin sufijo");
  // Sin la I esto devuelve 404 en la SEC de verdad. Comprobado el 14/09/2026.
  eq(
    frameUrl(eq2, 2024),
    "https://data.sec.gov/api/xbrl/frames/us-gaap/StockholdersEquity/USD/CY2024Q4I.json",
    "un saldo lleva Q4I",
  );
  eq(
    frameUrl(eps, 2024),
    "https://data.sec.gov/api/xbrl/frames/us-gaap/EarningsPerShareDiluted/USD-per-shares/CY2024.json",
    "el BPA usa su propia unidad",
  );
  const dei = FRAME_CONCEPTS.find((c) => c.taxonomy === "dei")!;
  truthy(frameUrl(dei, 2024).includes("/dei/"), "las acciones en circulacion salen de dei");
}

console.log("\n# el coste de barrer el mercado se sabe, no se estima");
{
  const plan = requestPlan([2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  eq(plan.concepts, 18, "dieciocho conceptos");
  eq(plan.requests, 180, "180 peticiones para diez años de TODO el mercado");
  // La simetria que lo resume: hoy son 18 peticiones para UNA empresa; por
  // frames son 18 conceptos para TODAS. 3.000 empresas en vivo serian 54.000.
  truthy(plan.requests < 54000 / 100, "dos ordenes de magnitud por debajo del camino en vivo");
}

console.log("\n# el pivote: de filas por concepto a series por empresa");
{
  const frames = [
    { tag: "Revenues", year: 2023, frame: frame([[2098, "2023-12-31", 1000, "ACME"], [320193, "2023-09-30", 383285, "APPLE"]]) },
    { tag: "Revenues", year: 2024, frame: frame([[2098, "2024-12-31", 1200, "ACME"], [320193, "2024-09-28", 391035, "APPLE"]]) },
    { tag: "NetIncomeLoss", year: 2024, frame: frame([[2098, "2024-12-31", 140, "ACME"]]) },
  ];
  const by = pivotFrames(frames);
  eq(by.size, 2, "dos empresas");
  eq(by.get("0000002098")!.get("Revenues")!.map((p) => [p.fy, p.val]), [[2023, 1000], [2024, 1200]], "ACME, dos años en orden");
  eq(by.get("0000320193")!.get("Revenues")!.at(-1)?.end, "2024-09-28", "Apple conserva su cierre de septiembre");
  eq(by.get("0000320193")!.has("NetIncomeLoss"), false, "lo que no declaro, no aparece");
  eq(cikKey(2098), "0000002098", "el CIK va a diez digitos");

  // Una reexpresion del mismo concepto y año: gana la ultima leida.
  const rehecho = pivotFrames([
    ...frames,
    { tag: "Revenues", year: 2024, frame: frame([[2098, "2024-12-31", 1250]]) },
  ]);
  eq(rehecho.get("0000002098")!.get("Revenues")!.at(-1)?.val, 1250, "una reexpresion pisa a la anterior");

  eq(namesFromFrames(frames).get("0000320193"), "APPLE", "el nombre sale del propio frame");
  eq(pivotFrames([]).size, 0, "sin frames, sin empresas");
  eq(pivotFrames([{ tag: "X", year: 2024, frame: {} }]).size, 0, "un frame vacio no rompe");
  eq(
    pivotFrames([{ tag: "X", year: 2024, frame: { data: [{ cik: 1, end: "2024-12-31", val: NaN }] } }]).size,
    0,
    "un valor no numerico se descarta",
  );
}

console.log("\n# de las series sale la misma tabla de siempre");
{
  const anios = [2023, 2024, 2025];
  const f = (tag: string, vals: number[], instant = false) =>
    anios.map((y, i) => ({
      tag,
      year: y,
      frame: frame([[2098, instant ? `${y}-12-31` : `${y}-12-31`, vals[i]]]),
    }));
  const by = pivotFrames([
    ...f("Revenues", [1000, 1200, 1500]),
    ...f("NetIncomeLoss", [100, 140, 180]),
    ...f("EarningsPerShareDiluted", [1, 1.4, 1.8]),
    ...f("StockholdersEquity", [500, 600, 700], true),
    ...f("NetCashProvidedByUsedInOperatingActivities", [150, 200, 260]),
    // Cambio de tag a mitad de historia: el fallo que dejo a NVDA sin capex.
    { tag: "PaymentsToAcquirePropertyPlantAndEquipment", year: 2023, frame: frame([[2098, "2023-12-31", 40]]) },
    { tag: "PaymentsToAcquirePropertyPlantAndEquipment", year: 2024, frame: frame([[2098, "2024-12-31", 50]]) },
    { tag: "PaymentsToAcquireProductiveAssets", year: 2025, frame: frame([[2098, "2025-12-31", 70]]) },
    ...f("LongTermDebt", [200, 190, 180], true),
    ...f("CashAndCashEquivalentsAtCarryingValue", [300, 350, 420], true),
    ...f("WeightedAverageNumberOfDilutedSharesOutstanding", [100, 100, 100]),
    { tag: "EntityCommonStockSharesOutstanding", year: 2025, frame: frame([[2098, "2025-12-31", 101]]) },
  ]);

  const view = financialsFromFrames(by.get("0000002098")!, AHORA);
  eq(view.years.length, 3, "tres ejercicios");
  eq(view.sharesOut, 101, "las acciones en circulacion");
  eq(view.years.map((y) => y.revenue), [1000, 1200, 1500], "los ingresos, en orden");
  eq(view.years.at(-1)?.capex, 70, "el capex del ultimo año sale del tag nuevo");
  eq(view.years.at(-1)?.fcf, 260 - 70, "y con el, el flujo de caja libre");
  eq(view.available, true, "la empresa queda valorable");

  // Una empresa que solo aparecio en un frame no puede fingir que tiene historia.
  const flaca = financialsFromFrames(pivotFrames([{ tag: "NetIncomeLoss", year: 2025, frame: frame([[7, "2025-12-31", 5]]) }]).get("0000000007")!, AHORA);
  eq(flaca.years.length, 1, "un solo año es un solo año");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
