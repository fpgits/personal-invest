import { padCik, secFetch } from "./edgar";
import {
  CAPEX_TAGS,
  CASH_TAGS,
  DEBT_TAGS,
  OCF_TAGS,
  REVENUE_TAGS,
  type RawUnitEntry,
} from "./edgar-facts";
import type { DailyClose } from "./market/stooq";

/**
 * Fundamentales "tal como se conocían" en una fecha pasada.
 *
 * La trampa clásica al estudiar el pasado es mirar cifras que entonces nadie
 * tenía: un 10-K del ejercicio 2025 se presenta en febrero de 2026, así que en
 * diciembre de 2025 NO existía. Aquí manda la fecha de PRESENTACIÓN (`filed`)
 * de cada dato, no el cierre del periodo: para una foto a la fecha D se usa
 * solo lo que la empresa ya había depositado en la SEC antes de D. Sin esto,
 * "aprender de los máximos del pasado" es aprender con las respuestas delante.
 *
 * Las cifras de flujo (ingresos, beneficio, caja generada) se toman del último
 * informe ANUAL ya presentado; las de balance (caja, deuda, patrimonio,
 * acciones) del último informe presentado, sea anual o trimestral, porque los
 * 10-Q también las traen y así la foto de balance es de hace un trimestre y no
 * de hace un año. Cada cifra lleva la fecha de su informe para saber lo vieja
 * que es.
 */

const CONCEPT_URL = (cik10: string, taxonomy: string, tag: string) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/${taxonomy}/${tag}.json`;

/** Un dato con su fecha de presentación, que es la que manda. */
export type DatedValue = { val: number; end: string; filed: string; form: string; fy: number | null };

/**
 * El último dato presentado en o antes de `date`. Para conceptos de flujo se
 * exige que cubra un ejercicio completo (no un trimestre); para instantes,
 * cualquier informe vale. Ante dos con la misma fecha de presentación, el de
 * periodo más reciente. Puro.
 */
export function asOf(
  entries: RawUnitEntry[] | undefined,
  date: string,
  kind: "flow" | "instant",
): DatedValue | null {
  if (!entries) return null;
  let best: RawUnitEntry | null = null;
  for (const e of entries) {
    if (!e.filed || e.filed > date) continue;
    if (!Number.isFinite(e.val)) continue;
    if (kind === "flow") {
      if (!e.start) continue;
      const days = (Date.parse(e.end) - Date.parse(e.start)) / 86400_000;
      if (!Number.isFinite(days) || days < 300 || days > 400) continue;
    }
    if (!best || e.filed > (best.filed ?? "") || (e.filed === best.filed && e.end > best.end)) best = e;
  }
  return best
    ? { val: best.val, end: best.end, filed: best.filed as string, form: best.form ?? "?", fy: best.fy ?? null }
    : null;
}

/** El dato anual inmediatamente anterior al dado (mismo criterio de presentación). Puro. */
export function priorAnnual(entries: RawUnitEntry[] | undefined, current: DatedValue, date: string): DatedValue | null {
  if (!entries) return null;
  let best: RawUnitEntry | null = null;
  for (const e of entries) {
    if (!e.filed || e.filed > date || !e.start || e.end >= current.end) continue;
    const days = (Date.parse(e.end) - Date.parse(e.start)) / 86400_000;
    if (!Number.isFinite(days) || days < 300 || days > 400) continue;
    // Debe terminar aproximadamente un año antes que el actual.
    const gap = (Date.parse(current.end) - Date.parse(e.end)) / 86400_000;
    if (gap < 300 || gap > 430) continue;
    if (!best || e.filed > (best.filed ?? "")) best = e;
  }
  return best
    ? { val: best.val, end: best.end, filed: best.filed as string, form: best.form ?? "?", fy: best.fy ?? null }
    : null;
}

/** Cierre en la fecha o el último anterior. Puro. */
export function priceAt(series: DailyClose[], date: string): DailyClose | null {
  let best: DailyClose | null = null;
  for (const p of series) {
    if (p.date > date) continue;
    if (!best || p.date > best.date) best = p;
  }
  return best;
}

/** Máximo de los `years` años anteriores a la fecha y caída desde él. Puro. */
export function drawdownAt(
  series: DailyClose[],
  date: string,
  years = 5,
): { high: number; highDate: string; drawdownPct: number } | null {
  const from = new Date(Date.parse(date) - years * 365.25 * 86400_000).toISOString().slice(0, 10);
  const at = priceAt(series, date);
  if (!at) return null;
  let high: DailyClose | null = null;
  for (const p of series) {
    if (p.date < from || p.date > date) continue;
    if (!high || p.close > high.close) high = p;
  }
  if (!high) return null;
  return { high: high.close, highDate: high.date, drawdownPct: round1((at.close / high.close - 1) * 100) };
}

export type Snapshot = {
  symbol: string;
  /** La fecha de la foto. */
  date: string;
  price: number | null;
  priceDate: string | null;
  sharesOut: number | null;
  marketCap: number | null;
  /** Ingresos del último ejercicio anual presentado antes de la fecha. */
  revenue: number | null;
  revenueGrowthPct: number | null;
  netIncome: number | null;
  netMarginPct: number | null;
  fcf: number | null;
  cash: number | null;
  debt: number | null;
  netDebt: number | null;
  equity: number | null;
  ps: number | null;
  pb: number | null;
  ev: number | null;
  evToSales: number | null;
  /** Caída desde el máximo de los 5 años anteriores a la fecha. */
  drawdownPct: number | null;
  highDate: string | null;
  /** De qué informes salen las cifras: para saber lo viejas que son. */
  asOf: { flowsFiled: string | null; flowsEnd: string | null; balanceFiled: string | null; balanceEnd: string | null };
};

export type RawConcepts = {
  revenue?: RawUnitEntry[];
  netIncome?: RawUnitEntry[];
  ocf?: RawUnitEntry[];
  capex?: RawUnitEntry[];
  cash?: RawUnitEntry[];
  debt?: RawUnitEntry[];
  equity?: RawUnitEntry[];
  sharesOut?: RawUnitEntry[];
};

/** Monta la foto a una fecha a partir de conceptos crudos y precios. Puro. */
export function snapshotAt(symbol: string, date: string, raw: RawConcepts, prices: DailyClose[]): Snapshot {
  const rev = asOf(raw.revenue, date, "flow");
  const ni = asOf(raw.netIncome, date, "flow");
  const ocf = asOf(raw.ocf, date, "flow");
  const capex = asOf(raw.capex, date, "flow");
  const cash = asOf(raw.cash, date, "instant");
  const debt = asOf(raw.debt, date, "instant");
  const equity = asOf(raw.equity, date, "instant");
  const shares = asOf(raw.sharesOut, date, "instant");
  const px = priceAt(prices, date);
  const dd = drawdownAt(prices, date);

  const price = px?.close ?? null;
  const sharesOut = shares?.val ?? null;
  const marketCap = price !== null && sharesOut !== null ? price * sharesOut : null;
  const revenue = rev?.val ?? null;
  const prev = rev ? priorAnnual(raw.revenue, rev, date) : null;
  const netIncome = ni?.val ?? null;
  const fcf = ocf && capex ? ocf.val - Math.abs(capex.val) : null;
  const c = cash?.val ?? null;
  const d = debt?.val ?? null;
  const netDebt = d !== null && c !== null ? d - c : d;
  const ev = marketCap !== null ? marketCap + (netDebt ?? 0) : null;

  return {
    symbol,
    date,
    price,
    priceDate: px?.date ?? null,
    sharesOut,
    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    revenue,
    revenueGrowthPct:
      revenue !== null && prev && prev.val !== 0 ? round1(((revenue - prev.val) / Math.abs(prev.val)) * 100) : null,
    netIncome,
    netMarginPct: revenue && netIncome !== null && revenue !== 0 ? round1((netIncome / revenue) * 100) : null,
    fcf,
    cash: c,
    debt: d,
    netDebt,
    equity: equity?.val ?? null,
    ps: marketCap !== null && revenue && revenue > 0 ? round2(marketCap / revenue) : null,
    pb: marketCap !== null && equity && equity.val > 0 ? round2(marketCap / equity.val) : null,
    ev: ev !== null ? Math.round(ev) : null,
    evToSales: ev !== null && revenue && revenue > 0 ? round2(ev / revenue) : null,
    drawdownPct: dd?.drawdownPct ?? null,
    highDate: dd?.highDate ?? null,
    asOf: {
      flowsFiled: rev?.filed ?? null,
      flowsEnd: rev?.end ?? null,
      balanceFiled: cash?.filed ?? shares?.filed ?? null,
      balanceEnd: cash?.end ?? shares?.end ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Datos: conceptos crudos de EDGAR, con su fecha de presentación.

const memo = new Map<string, { at: number; value: RawConcepts }>();
const TTL_MS = 24 * 60 * 60_000;

async function rawConcept(cik10: string, taxonomy: string, tag: string): Promise<RawUnitEntry[]> {
  try {
    const res = await secFetch(CONCEPT_URL(cik10, taxonomy, tag));
    const json = (await res.json()) as { units?: Record<string, RawUnitEntry[]> };
    const units = json.units ?? {};
    const key = Object.keys(units)[0];
    return key ? units[key] : [];
  } catch {
    return [];
  }
}

async function rawFirst(cik10: string, taxonomy: string, tags: string[]): Promise<RawUnitEntry[]> {
  for (const tag of tags) {
    const pts = await rawConcept(cik10, taxonomy, tag);
    if (pts.length > 0) return pts;
  }
  return [];
}

/** Todos los conceptos crudos de una empresa (con `filed`), memoizados un día. */
export async function rawConceptsFor(cik: string, now = Date.now()): Promise<RawConcepts> {
  const cik10 = padCik(cik);
  const hit = memo.get(cik10);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const [revenue, netIncome, ocf, capex] = await Promise.all([
    rawFirst(cik10, "us-gaap", REVENUE_TAGS),
    rawConcept(cik10, "us-gaap", "NetIncomeLoss"),
    rawFirst(cik10, "us-gaap", OCF_TAGS),
    rawFirst(cik10, "us-gaap", CAPEX_TAGS),
  ]);
  const [cash, debt, equity, sharesOut] = await Promise.all([
    rawFirst(cik10, "us-gaap", CASH_TAGS),
    rawFirst(cik10, "us-gaap", DEBT_TAGS),
    rawConcept(cik10, "us-gaap", "StockholdersEquity"),
    rawFirst(cik10, "dei", ["EntityCommonStockSharesOutstanding"]),
  ]);
  const value: RawConcepts = { revenue, netIncome, ocf, capex, cash, debt, equity, sharesOut };
  memo.set(cik10, { at: now, value });
  return value;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
