/**
 * Tests del lector del volcado en bloque de la SEC (puro, sin red).
 * Correr con: npm run test:edgar-bulk
 *
 * Lo que se comprueba de verdad aqui no es que el parser "funcione": es que
 * los dos caminos —la API en vivo y el archivo nocturno— lean lo MISMO. Si
 * divergieran, el veredicto de una empresa dependeria de por donde entro el
 * dato, y eso es peor que no tener el camino nuevo.
 */
import {
  coverageOf,
  conceptFromFacts,
  financialsFromFacts,
  mergedFromFacts,
  MIN_CONCEPTS,
  MIN_YEARS,
  type CompanyFacts,
} from "../src/lib/edgar-bulk";
import {
  buildFinancials,
  mergeAnnual,
  pickAnnual,
  REVENUE_TAGS,
  type RawUnitEntry,
} from "../src/lib/edgar-facts";

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

/** Un ejercicio anual tal y como viene en el zip. */
const fy = (year: number, val: number, extra: Record<string, unknown> = {}) => ({
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  val,
  fy: year,
  fp: "FY",
  form: "10-K",
  filed: `${year + 1}-02-15`,
  ...extra,
});
/** Un saldo (sin `start`): balance, no flujo. */
const bal = (year: number, val: number) => ({
  end: `${year}-12-31`,
  val,
  fy: year,
  fp: "FY",
  form: "10-K",
  filed: `${year + 1}-02-15`,
});

const AHORA = Date.parse("2026-06-30T00:00:00Z");

const acme: CompanyFacts = {
  cik: 1234,
  entityName: "Acme",
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [fy(2023, 1000), fy(2024, 1200), fy(2025, 1500)] } },
      NetIncomeLoss: { units: { USD: [fy(2023, 100), fy(2024, 140), fy(2025, 180)] } },
      EarningsPerShareDiluted: { units: { "USD/shares": [fy(2023, 1), fy(2024, 1.4), fy(2025, 1.8)] } },
      StockholdersEquity: { units: { USD: [bal(2023, 500), bal(2024, 600), bal(2025, 700)] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fy(2023, 150), fy(2024, 200), fy(2025, 260)] } },
      PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fy(2023, 40), fy(2024, 50)] } },
      // Cambio de tag a mitad de historia, el caso que rompio NVDA y AMZN.
      PaymentsToAcquireProductiveAssets: { units: { USD: [fy(2025, 70)] } },
      LongTermDebt: { units: { USD: [bal(2023, 200), bal(2024, 190), bal(2025, 180)] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [bal(2023, 300), bal(2024, 350), bal(2025, 420)] } },
      WeightedAverageNumberOfDilutedSharesOutstanding: {
        units: { shares: [fy(2023, 100), fy(2024, 100), fy(2025, 100)] },
      },
    },
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [bal(2025, 101)] } } },
  },
};

console.log("\n# un concepto del zip se lee igual que desde la API");
{
  const rev = conceptFromFacts(acme, "us-gaap", "Revenues");
  eq(rev.map((p) => p.val), [1000, 1200, 1500], "los tres ejercicios, en orden");
  eq(rev.at(-1)?.end, "2025-12-31", "con su fecha de cierre");
  eq(conceptFromFacts(acme, "us-gaap", "NoExiste"), [], "un tag que no esta devuelve vacio");
  eq(conceptFromFacts({}, "us-gaap", "Revenues"), [], "un blob vacio no rompe");
  eq(conceptFromFacts({ facts: { "us-gaap": { X: {} } } }, "us-gaap", "X"), [], "un concepto sin units no rompe");
  eq(
    conceptFromFacts({ facts: { "us-gaap": { X: { units: { USD: [] } } } } }, "us-gaap", "X"),
    [],
    "unidades vacias no rompen",
  );
}

console.log("\n# el cambio de tag a mitad de historia se sigue cosiendo");
{
  // Este es el fallo que dejaba a NVDA sin capex en el ultimo ejercicio y con
  // ello sin DCF. El camino nuevo tiene que heredar el arreglo, no repetirlo.
  const capex = mergedFromFacts(acme, "us-gaap", [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ]);
  eq(capex.map((p) => [p.fy, p.val]), [[2023, 40], [2024, 50], [2025, 70]], "los dos tags cosidos por ejercicio");
}

console.log("\n# los dos caminos dan exactamente la misma tabla");
{
  // El de siempre, armado a mano con las mismas funciones puras que usa la API.
  const units = (t: string) => acme.facts!["us-gaap"][t].units!;
  const primera = (u: Record<string, RawUnitEntry[]>) => pickAnnual(u[Object.keys(u)[0]]);
  const alaApi = buildFinancials(
    {
      revenue: mergeAnnual(REVENUE_TAGS.map((t) => (acme.facts!["us-gaap"][t] ? primera(units(t)) : []))),
      netIncome: primera(units("NetIncomeLoss")),
      eps: primera(units("EarningsPerShareDiluted")),
      equity: primera(units("StockholdersEquity")),
      sharesOut: 101,
      ocf: primera(units("NetCashProvidedByUsedInOperatingActivities")),
      capex: mergeAnnual([
        primera(units("PaymentsToAcquirePropertyPlantAndEquipment")),
        primera(units("PaymentsToAcquireProductiveAssets")),
      ]),
      debt: primera(units("LongTermDebt")),
      cash: primera(units("CashAndCashEquivalentsAtCarryingValue")),
      shares: primera(units("WeightedAverageNumberOfDilutedSharesOutstanding")),
    },
    AHORA,
  );
  const delZip = financialsFromFacts(acme, AHORA);
  eq(delZip.years, alaApi.years, "la tabla por ejercicio es identica");
  eq(delZip.sharesOut, alaApi.sharesOut, "las acciones en circulacion coinciden");
  eq(delZip.available, true, "y la empresa queda marcada como disponible");
}

console.log("\n# la cobertura se mide, no se supone");
{
  const cov = coverageOf(acme, financialsFromFacts(acme, AHORA), AHORA);
  eq(cov.concepts, 10, "los diez conceptos traen datos");
  eq(cov.lastFy, 2025, "el ultimo ejercicio leido");
  truthy(cov.years >= MIN_YEARS, `${cov.years} ejercicios, por encima del minimo`);
  truthy(cov.usable, "entra en el ranking");

  // Una empresa con dos cifras sueltas NO puede entrar: es justo la que
  // aparecería arriba del ranking por parecer baratísima sin serlo.
  const flaca: CompanyFacts = {
    facts: { "us-gaap": { NetIncomeLoss: { units: { USD: [fy(2025, 5)] } } } },
  };
  const covFlaca = coverageOf(flaca, financialsFromFacts(flaca, AHORA), AHORA);
  truthy(covFlaca.concepts < MIN_CONCEPTS, "un solo concepto no basta");
  truthy(!covFlaca.usable, "no entra en el ranking");

  // Cuentas congeladas: la empresa existio, pero no describe el presente.
  const vieja: CompanyFacts = {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [fy(2014, 100), fy(2015, 110), fy(2016, 120)] } },
        NetIncomeLoss: { units: { USD: [fy(2014, 10), fy(2015, 11), fy(2016, 12)] } },
        EarningsPerShareDiluted: { units: { "USD/shares": [fy(2014, 1), fy(2015, 1.1), fy(2016, 1.2)] } },
        StockholdersEquity: { units: { USD: [bal(2014, 50), bal(2015, 55), bal(2016, 60)] } },
        LongTermDebt: { units: { USD: [bal(2014, 20), bal(2015, 19), bal(2016, 18)] } },
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: [bal(2014, 30), bal(2015, 33), bal(2016, 36)] } },
      },
    },
  };
  const covVieja = coverageOf(vieja, financialsFromFacts(vieja, AHORA), AHORA);
  truthy(covVieja.concepts >= MIN_CONCEPTS, "tiene conceptos de sobra");
  eq(covVieja.lastFy, 2016, "pero su ultimo ejercicio es de hace una decada");
  truthy(!covVieja.usable, "unas cuentas congeladas no entran en el ranking");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
