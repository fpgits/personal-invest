import {
  buildFinancials,
  mergeAnnual,
  pickAnnual,
  CAPEX_TAGS,
  CASH_TAGS,
  DEBT_TAGS,
  OCF_TAGS,
  REVENUE_TAGS,
  SHARES_TAGS,
  type ConceptPoint,
  type FinancialsView,
  type RawUnitEntry,
} from "./edgar-facts";

/**
 * Los mismos fundamentales, pero desde el volcado en bloque de la SEC en vez
 * de la API.
 *
 * Por que existe este archivo. `companyFinancials()` hace DIECIOCHO peticiones
 * HTTP por empresa. Con el limite de acceso justo de la SEC (~10 por segundo)
 * eso son 45 segundos para 25 empresas, hora y media para 3.000 y tres horas
 * para el mercado entero — y una funcion de Vercel se corta a los 300
 * segundos. No es que fuera lento: es que la API en vivo no llega, ni de lejos.
 *
 * Y hay un segundo problema, mas silencioso: dieciocho peticiones son
 * dieciocho ocasiones de que una falle. Si se cae justo la del capex, no hay
 * flujo de caja libre, no hay DCF, y el veredicto de esa empresa cambia sin
 * que nadie lo note. Por eso el oraculo daba respuestas distintas en corridas
 * separadas por un minuto.
 *
 * `companyfacts.zip` arregla las dos cosas de una vez: un archivo con todos
 * los hechos XBRL de todos los declarantes, recompilado cada noche. Cero
 * peticiones por empresa, y como es un archivo y no una red, el mismo dia da
 * el mismo veredicto. Determinista por construccion.
 *
 * Lo que NO cambia es el criterio: la seleccion de valores anuales
 * (`pickAnnual`), la union de tags equivalentes (`mergeAnnual`) y la tabla por
 * ejercicio (`buildFinancials`) son las mismas funciones ya probadas. Aqui
 * solo cambia de donde salen los bytes.
 */

/** Un concepto dentro del volcado: mismo `units` que devuelve la API. */
export type BulkConcept = { units?: Record<string, RawUnitEntry[]> };

/** El JSON de una empresa dentro de `companyfacts.zip`. */
export type CompanyFacts = {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, BulkConcept>>;
};

/**
 * Un concepto del volcado como puntos anuales.
 *
 * La estructura de `units` dentro del zip es identica a la que sirve
 * `companyconcept`, asi que `pickAnnual` vale tal cual — ese es el motivo de
 * que este cambio sea pequeno en vez de una reescritura.
 */
export function conceptFromFacts(facts: CompanyFacts, taxonomy: string, tag: string): ConceptPoint[] {
  const units = facts.facts?.[taxonomy]?.[tag]?.units;
  if (!units) return [];
  // La primera clave con datos: USD para importes, USD/shares para el BPA,
  // shares para los recuentos. Igual que hace el camino de la API.
  const key = Object.keys(units).find((k) => (units[k] ?? []).length > 0);
  return key ? pickAnnual(units[key]) : [];
}

/** Varios tags que significan lo mismo, unidos por ejercicio. */
export function mergedFromFacts(facts: CompanyFacts, taxonomy: string, tags: string[]): ConceptPoint[] {
  return mergeAnnual(tags.map((t) => conceptFromFacts(facts, taxonomy, t)));
}

/**
 * La misma `FinancialsView` que `companyFinancials()`, sin tocar la red.
 *
 * La lista de conceptos se mantiene deliberadamente igual a la del camino en
 * vivo: si los dos caminos leyeran cosas distintas, el veredicto dependeria de
 * por donde entro el dato, que es justo lo que se quiere evitar.
 */
export function financialsFromFacts(facts: CompanyFacts, now = Date.now()): FinancialsView {
  return buildFinancials(
    {
      revenue: mergedFromFacts(facts, "us-gaap", REVENUE_TAGS),
      netIncome: conceptFromFacts(facts, "us-gaap", "NetIncomeLoss"),
      eps: conceptFromFacts(facts, "us-gaap", "EarningsPerShareDiluted"),
      equity: conceptFromFacts(facts, "us-gaap", "StockholdersEquity"),
      sharesOut: mergedFromFacts(facts, "dei", ["EntityCommonStockSharesOutstanding"]).at(-1)?.val ?? null,
      ocf: mergedFromFacts(facts, "us-gaap", OCF_TAGS),
      capex: mergedFromFacts(facts, "us-gaap", CAPEX_TAGS),
      debt: mergedFromFacts(facts, "us-gaap", DEBT_TAGS),
      cash: mergedFromFacts(facts, "us-gaap", CASH_TAGS),
      shares: mergedFromFacts(facts, "us-gaap", SHARES_TAGS),
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Cobertura

/**
 * Por que se mide esto y no solo si "hay datos".
 *
 * Hoy, con 25 nombres escogidos a mano, NUEVE salen sin cobertura: un 36%. A
 * 3.000 nombres eso serian ~1.100 huecos, y el ranking se construiria con los
 * que sobrevivieron al lector. "Las mas baratas del mercado" seria en realidad
 * "las mas baratas de las que supimos leer", que es un sesgo de supervivencia
 * colocado justo en la parte de la pantalla que mas se mira.
 *
 * Guardar la cobertura junto a las cifras permite responder a "¿de cuantas del
 * universo sabemos algo?" sin adivinarlo, y excluir del ranking lo que no
 * llegue a un minimo en vez de dejarlo colarse a medias.
 */
export type Coverage = {
  /** Ejercicios con cifras utiles. */
  years: number;
  /** De los diez conceptos, cuantos traen al menos un ano. */
  concepts: number;
  /** Ejercicio mas reciente leido, para detectar historias congeladas. */
  lastFy: number | null;
  /** Suficiente para valorar: sin esto, la empresa no entra en el ranking. */
  usable: boolean;
};

/** Minimo para que una empresa pueda entrar en un ranking sin enganar. */
export const MIN_YEARS = 3;
export const MIN_CONCEPTS = 5;
/** Cuentas mas viejas que esto no describen la empresa de hoy. */
export const MAX_STALE_YEARS = 3;

export function coverageOf(facts: CompanyFacts, view: FinancialsView, now = Date.now()): Coverage {
  const concepts = [
    mergedFromFacts(facts, "us-gaap", REVENUE_TAGS),
    conceptFromFacts(facts, "us-gaap", "NetIncomeLoss"),
    conceptFromFacts(facts, "us-gaap", "EarningsPerShareDiluted"),
    conceptFromFacts(facts, "us-gaap", "StockholdersEquity"),
    mergedFromFacts(facts, "dei", ["EntityCommonStockSharesOutstanding"]),
    mergedFromFacts(facts, "us-gaap", OCF_TAGS),
    mergedFromFacts(facts, "us-gaap", CAPEX_TAGS),
    mergedFromFacts(facts, "us-gaap", DEBT_TAGS),
    mergedFromFacts(facts, "us-gaap", CASH_TAGS),
    mergedFromFacts(facts, "us-gaap", SHARES_TAGS),
  ].filter((pts) => pts.length > 0).length;

  const years = view.years.length;
  const lastFy = view.years.at(-1)?.fy ?? null;
  const thisYear = new Date(now).getUTCFullYear();
  const fresh = lastFy !== null && thisYear - lastFy <= MAX_STALE_YEARS;

  return {
    years,
    concepts,
    lastFy,
    usable: years >= MIN_YEARS && concepts >= MIN_CONCEPTS && fresh,
  };
}
