import {
  buildFinancials,
  mergeAnnual,
  CAPEX_TAGS,
  CASH_TAGS,
  DEBT_TAGS,
  OCF_TAGS,
  REVENUE_TAGS,
  SHARES_TAGS,
  type ConceptPoint,
  type FinancialsView,
} from "./edgar-facts";

/**
 * El mercado entero, por conceptos en vez de por empresas.
 *
 * La API de `frames` de la SEC devuelve UN concepto de UN periodo para TODAS
 * las empresas que lo declararon, en una sola peticion. Medido contra la SEC
 * real: `us-gaap/NetIncomeLoss/USD/CY2024` son **6.054 empresas en 901 KB**.
 *
 * Eso da la vuelta al problema. El camino de hoy pide 18 peticiones POR
 * EMPRESA — tres horas para el mercado y ni una funcion de Vercel aguanta.
 * Por frames son ~16 conceptos x ~10 años = unas 160 peticiones para TODO el
 * mercado: 16 segundos al limite de acceso justo de la SEC, y unos 95 MB.
 * Cabe holgadamente en un cron.
 *
 * Tambien deja obsoleto el plan del zip. `companyfacts.zip` son gigabytes que
 * hay que descomprimir en streaming para responder "todo de una empresa";
 * frames responde "una cosa de todas las empresas", que es justo la pregunta
 * de un buscador de mercado. Los dos modulos se quedan: `edgar-bulk.ts` sirve
 * cuando quieres el detalle de una sola, este cuando quieres barrer.
 *
 * Lo que NO cambia, otra vez: `mergeAnnual` y `buildFinancials` son las mismas
 * de siempre. Aqui solo se pivota de "filas por concepto" a "series por
 * empresa" y se les entrega el resultado.
 */

/** Una fila de un frame: una empresa que declaro ese concepto ese periodo. */
export type FrameRow = {
  cik: number;
  entityName?: string;
  start?: string;
  end: string;
  val: number;
};

export type Frame = { taxonomy?: string; tag?: string; ccp?: string; uom?: string; data?: FrameRow[] };

/**
 * Un concepto de los que necesita el motor, con lo que hace falta para pedirlo.
 *
 * `kind` no es un detalle: un frame de flujo (ingresos, beneficio) se pide
 * como `CY2024`, y uno de saldo (patrimonio, caja, deuda) como `CY2024Q4I`
 * — con la I de instantaneo. Pedir un saldo sin la I devuelve 404, ni datos
 * vacios ni un error util. Comprobado.
 */
export type FrameConcept = {
  taxonomy: "us-gaap" | "dei";
  tag: string;
  uom: string;
  kind: "flow" | "instant";
};

const usd = (tag: string, kind: FrameConcept["kind"]): FrameConcept => ({
  taxonomy: "us-gaap",
  tag,
  uom: "USD",
  kind,
});

/**
 * Los mismos conceptos que pide `companyFinancials`, en la misma prioridad.
 * Si los dos caminos leyeran cosas distintas, el veredicto de una empresa
 * dependeria de por donde entro el dato.
 */
export const FRAME_CONCEPTS: FrameConcept[] = [
  ...REVENUE_TAGS.map((t) => usd(t, "flow")),
  usd("NetIncomeLoss", "flow"),
  { taxonomy: "us-gaap", tag: "EarningsPerShareDiluted", uom: "USD-per-shares", kind: "flow" },
  usd("StockholdersEquity", "instant"),
  ...OCF_TAGS.map((t) => usd(t, "flow")),
  ...CAPEX_TAGS.map((t) => usd(t, "flow")),
  ...DEBT_TAGS.map((t) => usd(t, "instant")),
  ...CASH_TAGS.map((t) => usd(t, "instant")),
  ...SHARES_TAGS.map((t) => ({ taxonomy: "us-gaap" as const, tag: t, uom: "shares", kind: "flow" as const })),
  { taxonomy: "dei", tag: "EntityCommonStockSharesOutstanding", uom: "shares", kind: "instant" },
];

/** La URL del frame. Puro. */
export function frameUrl(c: FrameConcept, year: number): string {
  const period = c.kind === "instant" ? `CY${year}Q4I` : `CY${year}`;
  return `https://data.sec.gov/api/xbrl/frames/${c.taxonomy}/${c.tag}/${c.uom}/${period}.json`;
}

/** CIK a diez digitos con ceros, la clave con la que habla la SEC. */
export const cikKey = (cik: number | string): string => String(cik).replace(/\D/g, "").padStart(10, "0");

/** Series por empresa y por tag, que es lo que hace falta para valorar. */
export type ByCompany = Map<string, Map<string, ConceptPoint[]>>;

/**
 * Pivota los frames descargados: de "una fila por empresa dentro de un
 * concepto" a "las series de cada empresa".
 *
 * El `fy` sale del frame pedido, no de la fila. Es deliberado: las filas de un
 * frame traen cierres distintos (Air Products cierra en septiembre y aparece
 * igual en CY2024), y la SEC ya ha hecho el trabajo de decidir a que ejercicio
 * natural corresponde cada uno. Fiarse de eso es mas fiable que reconstruirlo
 * a partir de la fecha.
 *
 * Si una empresa repite concepto y año —puede pasar con reexpresiones— gana la
 * ultima fila leida, igual que el camino en vivo se queda con la declarada mas
 * tarde. Puro.
 */
export function pivotFrames(frames: Array<{ tag: string; year: number; frame: Frame }>): ByCompany {
  const out: ByCompany = new Map();
  for (const { tag, year, frame } of frames) {
    for (const row of frame.data ?? []) {
      if (!Number.isFinite(row.val) || typeof row.end !== "string") continue;
      const key = cikKey(row.cik);
      let byTag = out.get(key);
      if (!byTag) out.set(key, (byTag = new Map()));
      const pts = byTag.get(tag) ?? [];
      const i = pts.findIndex((p) => p.fy === year);
      const point: ConceptPoint = { fy: year, end: row.end, val: row.val };
      if (i >= 0) pts[i] = point;
      else pts.push(point);
      byTag.set(tag, pts.sort((a, b) => a.fy - b.fy));
    }
  }
  return out;
}

/** Nombres tal y como los escribe la SEC, para no depender de otra fuente. */
export function namesFromFrames(frames: Array<{ frame: Frame }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { frame } of frames) {
    for (const row of frame.data ?? []) {
      const key = cikKey(row.cik);
      if (row.entityName && !out.has(key)) out.set(key, row.entityName);
    }
  }
  return out;
}

const seriesOf = (byTag: Map<string, ConceptPoint[]>, tags: string[]): ConceptPoint[] =>
  mergeAnnual(tags.map((t) => byTag.get(t) ?? []));

/** La misma `FinancialsView` de siempre, armada desde los frames. */
export function financialsFromFrames(byTag: Map<string, ConceptPoint[]>, now = Date.now()): FinancialsView {
  return buildFinancials(
    {
      revenue: seriesOf(byTag, REVENUE_TAGS),
      netIncome: seriesOf(byTag, ["NetIncomeLoss"]),
      eps: seriesOf(byTag, ["EarningsPerShareDiluted"]),
      equity: seriesOf(byTag, ["StockholdersEquity"]),
      sharesOut: byTag.get("EntityCommonStockSharesOutstanding")?.at(-1)?.val ?? null,
      ocf: seriesOf(byTag, OCF_TAGS),
      capex: seriesOf(byTag, CAPEX_TAGS),
      debt: seriesOf(byTag, DEBT_TAGS),
      cash: seriesOf(byTag, CASH_TAGS),
      shares: seriesOf(byTag, SHARES_TAGS),
    },
    now,
  );
}

/** Cuantas peticiones cuesta barrer el mercado. Para poder decirlo, no estimarlo. */
export function requestPlan(years: number[]): { requests: number; concepts: number; years: number } {
  return { requests: FRAME_CONCEPTS.length * years.length, concepts: FRAME_CONCEPTS.length, years: years.length };
}
