import type { RawUnitEntry } from "./edgar-facts";

/**
 * Ultimos doce meses calculados EN CASA desde los informes de la SEC.
 *
 * Por que existe este modulo: hasta ahora los multiplos (PER, P/V, margenes)
 * venian ya calculados de un proveedor de mercado, y al contrastarlos con los
 * informes no cuadraban. De catorce acciones de la cartera, UNA sola cuadraba:
 * el BPA del proveedor era 6,5 veces el declarado en NVDA, 4,3 en Amazon, iba
 * al reves en Tesla, y en tres empresas daba beneficios donde el informe
 * declaraba perdidas. Sobre eso se estaban dando veredictos y recortes en
 * dolares.
 *
 * La regla nueva: todo lo que decide sale de un informe con fecha. El
 * proveedor de mercado se queda solo con lo que EDGAR no tiene (el precio, la
 * beta, el rango de 52 semanas).
 *
 * Tres decisiones de diseno, cada una por un fallo real visto en los datos:
 *
 *  1. NO se filtra por `fy`/`fp`. Las etiquetas de ejercicio fiscal de EDGAR
 *     son inconsistentes: en IBKR el trimestre cerrado el 31/03/2025 aparece
 *     como fy2026-Q1 y el de 30/09/2025 como fy2025-Q3. Lo unico fiable es la
 *     pareja start/end y la longitud del periodo.
 *  2. Se compone el TTM sumando los CUATRO ULTIMOS TRIMESTRES, no cogiendo el
 *     ultimo ejercicio cerrado. Un anual de hace once meses no son los ultimos
 *     doce meses. Cuando falta el cuarto trimestre (casi nadie presenta 10-Q
 *     del Q4) se deriva: ejercicio completo menos los nueve meses.
 *  3. Una serie CADUCA no vale. IBKR dejo de declarar NetIncomeLoss en 2013 y
 *     se paso a ProfitLoss; el codigo viejo cogia el primer tag con datos y se
 *     quedaba con cifras de 2014 tan tranquilo. Aqui una serie cuyo ultimo
 *     periodo es viejo se descarta y se prueba la siguiente.
 *
 * Todo el nucleo es puro: recibe las unidades crudas de EDGAR y no toca la red.
 */

/** Un periodo de flujo (ingresos, beneficio, caja): tiene principio y fin. */
export type Span = {
  start: string;
  end: string;
  val: number;
  filed: string;
  /** Dias que abarca. Es lo que distingue un trimestre de un ejercicio. */
  days: number;
};

/** Un valor de balance: una foto a una fecha (caja, deuda, patrimonio). */
export type Instant = { end: string; val: number; filed: string };

/** Longitudes de periodo, en dias. Los cierres fiscales no son exactos. */
export const QUARTER_MIN = 80;
export const QUARTER_MAX = 100;
export const NINE_MONTH_MIN = 250;
export const NINE_MONTH_MAX = 290;
export const ANNUAL_MIN = 330;
export const ANNUAL_MAX = 400;
/** A partir de aqui una serie se considera caduca (dos trimestres de retraso). */
export const STALE_DAYS = 200;

const DAY = 86400_000;

function days(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY);
}

/**
 * Periodos de flujo, sin duplicados y con las reexpresiones aplicadas: de dos
 * declaraciones del mismo periodo gana la presentada mas tarde.
 */
export function flowPeriods(entries: RawUnitEntry[] | undefined): Span[] {
  const by = new Map<string, Span>();
  for (const e of entries ?? []) {
    if (!e.start || !e.end || !Number.isFinite(e.val)) continue;
    const d = days(e.start, e.end);
    if (!Number.isFinite(d) || d <= 0) continue;
    const key = `${e.start}|${e.end}`;
    const prev = by.get(key);
    const filed = e.filed ?? "";
    if (!prev || filed > prev.filed) by.set(key, { start: e.start, end: e.end, val: e.val, filed, days: d });
  }
  return [...by.values()].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

/** Valores de balance (sin `start`), sin duplicados por fecha. */
export function instants(entries: RawUnitEntry[] | undefined): Instant[] {
  const by = new Map<string, Instant>();
  for (const e of entries ?? []) {
    if (e.start || !e.end || !Number.isFinite(e.val)) continue;
    const prev = by.get(e.end);
    const filed = e.filed ?? "";
    if (!prev || filed > prev.filed) by.set(e.end, { end: e.end, val: e.val, filed });
  }
  return [...by.values()].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

const isQuarter = (s: Span) => s.days >= QUARTER_MIN && s.days <= QUARTER_MAX;
const isNineMonth = (s: Span) => s.days >= NINE_MONTH_MIN && s.days <= NINE_MONTH_MAX;
const isAnnual = (s: Span) => s.days >= ANNUAL_MIN && s.days <= ANNUAL_MAX;

/**
 * Trimestres declarados MAS los derivados. Casi ninguna empresa presenta un
 * 10-Q del cuarto trimestre: ese dato solo existe restando los nueve meses al
 * ejercicio completo. Sin esto, el TTM de cualquier empresa recien cerrado el
 * ano se quedaria cojo justo cuando mas fresco deberia estar. Puro.
 */
export function derivedQuarters(spans: Span[]): Span[] {
  const real = spans.filter(isQuarter);
  const seen = new Set(real.map((q) => `${q.start}|${q.end}`));
  const out = [...real];

  for (const year of spans.filter(isAnnual)) {
    // Los nueve meses que empiezan el mismo dia que el ejercicio.
    const nine = spans.find((s) => isNineMonth(s) && s.start === year.start);
    if (!nine) continue;
    const gap = days(nine.end, year.end);
    if (gap < QUARTER_MIN || gap > QUARTER_MAX) continue;
    const key = `${nine.end}|${year.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      start: nine.end,
      end: year.end,
      val: year.val - nine.val,
      // La fecha de presentacion es la del informe mas tardio de los dos: es
      // cuando el dato derivado se pudo conocer.
      filed: year.filed > nine.filed ? year.filed : nine.filed,
      days: gap,
    });
  }
  return out.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

export type TtmFlow = {
  value: number;
  /** "quarters" = suma de cuatro trimestres; "annual" = ultimo ejercicio. */
  basis: "quarters" | "annual";
  from: string;
  to: string;
  filed: string;
  /** Periodos usados, para poder rastrear la cifra hasta su informe. */
  periods: Array<{ start: string; end: string; val: number }>;
};

/**
 * Los ultimos doce meses de una magnitud de flujo. Prefiere cuatro trimestres
 * seguidos; si no los hay, el ultimo ejercicio completo. Devuelve null si lo
 * mas reciente que encuentra esta caduco: mejor sin dato que con uno de 2014.
 */
export function ttmFlow(entries: RawUnitEntry[] | undefined, now = new Date()): TtmFlow | null {
  const spans = flowPeriods(entries);
  if (spans.length === 0) return null;
  const limit = new Date(now.getTime() - STALE_DAYS * DAY).toISOString().slice(0, 10);

  const qs = derivedQuarters(spans);
  const last4 = qs.slice(-4);
  if (last4.length === 4 && last4[3].end >= limit) {
    // Tienen que encadenar: si falta un trimestre por medio, la suma mentiria.
    let contiguous = true;
    for (let i = 1; i < 4; i++) {
      if (Math.abs(days(last4[i - 1].end, last4[i].start)) > 10) contiguous = false;
    }
    if (contiguous) {
      return {
        value: last4.reduce((s, q) => s + q.val, 0),
        basis: "quarters",
        from: last4[0].start,
        to: last4[3].end,
        filed: last4.reduce((f, q) => (q.filed > f ? q.filed : f), ""),
        periods: last4.map((q) => ({ start: q.start, end: q.end, val: q.val })),
      };
    }
  }

  const year = spans.filter(isAnnual).at(-1);
  if (!year || year.end < limit) return null;
  return {
    value: year.val,
    basis: "annual",
    from: year.start,
    to: year.end,
    filed: year.filed,
    periods: [{ start: year.start, end: year.end, val: year.val }],
  };
}

/** La foto de balance mas reciente, si no esta caduca. */
export function latestInstant(entries: RawUnitEntry[] | undefined, now = new Date()): Instant | null {
  const list = instants(entries);
  const last = list.at(-1);
  if (!last) return null;
  const limit = new Date(now.getTime() - STALE_DAYS * DAY).toISOString().slice(0, 10);
  return last.end >= limit ? last : null;
}

/**
 * De varias series equivalentes (una empresa puede cambiar de etiqueta), la
 * primera que este VIVA. El orden de la lista es la preferencia; la frescura
 * manda sobre la preferencia. Este es el arreglo de IBKR: NetIncomeLoss murio
 * en 2013 y ProfitLoss sigue vivo, y antes ganaba el muerto.
 */
export function firstLive<T>(
  series: Array<RawUnitEntry[] | undefined>,
  read: (e: RawUnitEntry[] | undefined) => T | null,
): { value: T; index: number } | null {
  for (let i = 0; i < series.length; i++) {
    const v = read(series[i]);
    if (v !== null) return { value: v, index: i };
  }
  return null;
}
