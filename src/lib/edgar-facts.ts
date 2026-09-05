import { padCik, secFetch } from "./edgar";

/**
 * Fundamentales historicos desde EDGAR (XBRL companyfacts), la fuente
 * primaria. En vez de fiarnos de los ratios superficiales de un agregador,
 * bajamos las cifras que la propia empresa declara a la SEC y calculamos los
 * multiplos aqui, contra el precio actual. Cada numero ata a un 10-K.
 *
 * No necesita clave: la SEC solo exige el User-Agent con contacto, que ya
 * pone `secFetch` (SEC_CONTACT_EMAIL). ~10 peticiones/seg; aqui vamos con unas
 * pocas por empresa y bajo demanda.
 */

const CONCEPT_URL = (cik10: string, taxonomy: string, tag: string) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/${taxonomy}/${tag}.json`;

/** Un valor anual de un concepto XBRL: ejercicio fiscal, fin de periodo y cifra. */
export type ConceptPoint = { fy: number; end: string; val: number };

/** Forma cruda de las "units" de companyconcept (lo que nos interesa). */
export type RawUnitEntry = {
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  start?: string;
};

/**
 * De las unidades de un concepto, saca un valor por ejercicio fiscal:
 *  - solo informes anuales (10-K / 20-F), fp = FY;
 *  - un valor por `fy`, quedandose con el declarado mas tarde (restatements);
 *  - para conceptos de flujo (ingresos), el periodo que cubre el ano completo
 *    (~360+ dias) para no colar un trimestre marcado como FY.
 * Puro y testeable.
 */
export function pickAnnual(entries: RawUnitEntry[] | undefined): ConceptPoint[] {
  if (!entries) return [];
  const byFy = new Map<number, RawUnitEntry>();
  for (const e of entries) {
    if (e.fp !== "FY") continue;
    if (e.form !== "10-K" && e.form !== "20-F") continue;
    if (typeof e.fy !== "number" || !Number.isFinite(e.val)) continue;
    // Flujo (tiene start): exige que abarque el ano, no un trimestre.
    if (e.start) {
      const days = (Date.parse(e.end) - Date.parse(e.start)) / 86400_000;
      if (Number.isFinite(days) && days < 300) continue;
    }
    const prev = byFy.get(e.fy);
    if (!prev || (e.filed ?? "") > (prev.filed ?? "")) byFy.set(e.fy, e);
  }
  return [...byFy.values()]
    .map((e) => ({ fy: e.fy as number, end: e.end, val: e.val }))
    .sort((a, b) => a.fy - b.fy);
}

/** Baja un concepto y devuelve sus puntos anuales; [] si no existe el tag. */
async function annual(cik10: string, taxonomy: string, tag: string): Promise<ConceptPoint[]> {
  try {
    const res = await secFetch(CONCEPT_URL(cik10, taxonomy, tag));
    const json = (await res.json()) as { units?: Record<string, RawUnitEntry[]> };
    const units = json.units ?? {};
    // El primer set de unidades que traiga datos (USD, o USD/shares para BPA).
    const key = Object.keys(units)[0];
    return key ? pickAnnual(units[key]) : [];
  } catch {
    return [];
  }
}

/** Prueba varios tags en orden y se queda con el primero que traiga datos. */
async function annualFirst(
  cik10: string,
  taxonomy: string,
  tags: string[],
): Promise<ConceptPoint[]> {
  for (const tag of tags) {
    const pts = await annual(cik10, taxonomy, tag);
    if (pts.length > 0) return pts;
  }
  return [];
}

export type FinancialYear = {
  fy: number;
  revenue: number | null;
  netIncome: number | null;
  /** beneficio neto / ingresos, en %. */
  netMargin: number | null;
  eps: number | null;
  equity: number | null;
  /** crecimiento de ingresos frente al ano anterior, en %. */
  revenueGrowth: number | null;
  /** Caja generada por las operaciones. */
  ocf: number | null;
  /** Inversion en inmovilizado (capex), en positivo. */
  capex: number | null;
  /** Flujo de caja libre = OCF - capex: el "beneficio del dueno". */
  fcf: number | null;
  /** FCF / ingresos, en %. */
  fcfMargin: number | null;
  /** Deuda a largo plazo. */
  debt: number | null;
  /** Caja y equivalentes. */
  cash: number | null;
  /** Deuda menos caja; negativo = caja neta. */
  netDebt: number | null;
  /** Acciones diluidas medias del ejercicio (para ver recompras/dilucion). */
  shares: number | null;
};

export type FinancialsView = {
  years: FinancialYear[];
  sharesOut: number | null;
  updatedAt: number;
  available: boolean;
};

/** Empresas usan distintos tags para lo mismo; se prueban en orden. */
export const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];
export const OCF_TAGS = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
];
export const CAPEX_TAGS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
];
export const DEBT_TAGS = ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"];
export const CASH_TAGS = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
];
export const SHARES_TAGS = ["WeightedAverageNumberOfDilutedSharesOutstanding"];

/** Combina las series de conceptos en una tabla por ano. Puro y testeable. */
export function buildFinancials(
  input: {
    revenue: ConceptPoint[];
    netIncome: ConceptPoint[];
    eps: ConceptPoint[];
    equity: ConceptPoint[];
    sharesOut?: number | null;
    ocf?: ConceptPoint[];
    capex?: ConceptPoint[];
    debt?: ConceptPoint[];
    cash?: ConceptPoint[];
    shares?: ConceptPoint[];
  },
  now: number,
  maxYears = 8,
): FinancialsView {
  const map = (pts: ConceptPoint[] | undefined) => new Map((pts ?? []).map((p) => [p.fy, p.val]));
  const rev = map(input.revenue);
  const ni = map(input.netIncome);
  const eps = map(input.eps);
  const eq = map(input.equity);
  const ocf = map(input.ocf);
  const capex = map(input.capex);
  const debt = map(input.debt);
  const cash = map(input.cash);
  const shares = map(input.shares);

  const fys = [...new Set([...rev.keys(), ...ni.keys(), ...eps.keys(), ...eq.keys(), ...ocf.keys()])].sort(
    (a, b) => a - b,
  );

  const years: FinancialYear[] = fys.map((fy) => {
    const revenue = rev.get(fy) ?? null;
    const netIncome = ni.get(fy) ?? null;
    const prevRev = rev.get(fy - 1) ?? null;
    const o = ocf.get(fy) ?? null;
    const c = capex.get(fy) ?? null;
    // Sin dato de capex pero con OCF, el FCF queda sin calcular: no se
    // inventa un capex cero (sobreestimaria el FCF de una industria pesada).
    const fcf = o !== null && c !== null ? o - Math.abs(c) : null;
    const d = debt.get(fy) ?? null;
    const k = cash.get(fy) ?? null;
    return {
      fy,
      revenue,
      netIncome,
      netMargin: revenue && netIncome !== null && revenue !== 0 ? round((netIncome / revenue) * 100, 1) : null,
      eps: eps.get(fy) ?? null,
      equity: eq.get(fy) ?? null,
      revenueGrowth:
        revenue !== null && prevRev !== null && prevRev !== 0
          ? round(((revenue - prevRev) / Math.abs(prevRev)) * 100, 1)
          : null,
      ocf: o,
      capex: c !== null ? Math.abs(c) : null,
      fcf,
      fcfMargin: fcf !== null && revenue && revenue !== 0 ? round((fcf / revenue) * 100, 1) : null,
      debt: d,
      cash: k,
      netDebt: d !== null && k !== null ? d - k : d !== null ? d : null,
      shares: shares.get(fy) ?? null,
    };
  });

  const trimmed = years.slice(-maxYears);
  return {
    years: trimmed,
    sharesOut: input.sharesOut ?? null,
    updatedAt: now,
    available: trimmed.some((y) => y.revenue !== null || y.netIncome !== null || y.eps !== null),
  };
}

export type Multiples = { pe: number | null; ps: number | null; pb: number | null };

/**
 * Multiplos calculados en vivo contra el precio: PER (precio/BPA), P/S
 * (capitalizacion/ingresos) y P/B (precio/valor contable por accion). Se
 * usan las cifras del ultimo ejercicio anual de EDGAR.
 */
export function multiples(view: FinancialsView, price: number | null, marketCap: number | null): Multiples {
  const last = view.years.at(-1);
  if (!last || !price || price <= 0) return { pe: null, ps: null, pb: null };
  const pe = last.eps && last.eps > 0 ? round(price / last.eps, 1) : null;
  const ps = marketCap && last.revenue && last.revenue > 0 ? round(marketCap / last.revenue, 1) : null;
  const bvps = last.equity && view.sharesOut && view.sharesOut > 0 ? last.equity / view.sharesOut : null;
  const pb = bvps && bvps > 0 ? round(price / bvps, 1) : null;
  return { pe, ps, pb };
}

/** Resumen en texto para el prompt de la IA (tesis). Vacio si no hay datos. */
export function financialsToText(view: FinancialsView): string {
  if (!view.available) return "";
  const lines: string[] = ["Fundamentales anuales (SEC EDGAR, 10-K):"];
  for (const y of view.years) {
    const parts: string[] = [];
    if (y.revenue !== null) parts.push(`ingresos ${money(y.revenue)}`);
    if (y.revenueGrowth !== null) parts.push(`(${y.revenueGrowth > 0 ? "+" : ""}${y.revenueGrowth}% a/a)`);
    if (y.netIncome !== null) parts.push(`beneficio ${money(y.netIncome)}`);
    if (y.netMargin !== null) parts.push(`margen ${y.netMargin}%`);
    if (y.eps !== null) parts.push(`BPA ${y.eps}`);
    if (y.fcf !== null) parts.push(`FCF ${money(y.fcf)}`);
    if (y.netDebt !== null) parts.push(y.netDebt <= 0 ? `caja neta ${money(-y.netDebt)}` : `deuda neta ${money(y.netDebt)}`);
    if (parts.length > 0) lines.push(`FY${y.fy}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Lectura con cache por empresa

const TTL_MS = 6 * 60 * 60_000;
const memo = new Map<string, { at: number; value: FinancialsView }>();

export async function companyFinancials(cik: string, now = Date.now()): Promise<FinancialsView> {
  const cik10 = padCik(cik);
  const hit = memo.get(cik10);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  // Dos tandas de cinco: la SEC admite ~10 peticiones/seg y el motor evalua
  // varias empresas a la vez.
  const [revenue, netIncome, eps, equity, shares] = await Promise.all([
    annualFirst(cik10, "us-gaap", REVENUE_TAGS),
    annual(cik10, "us-gaap", "NetIncomeLoss"),
    annual(cik10, "us-gaap", "EarningsPerShareDiluted"),
    annual(cik10, "us-gaap", "StockholdersEquity"),
    annualFirst(cik10, "dei", ["EntityCommonStockSharesOutstanding"]),
  ]);
  const [ocf, capex, debt, cash, dilutedShares] = await Promise.all([
    annualFirst(cik10, "us-gaap", OCF_TAGS),
    annualFirst(cik10, "us-gaap", CAPEX_TAGS),
    annualFirst(cik10, "us-gaap", DEBT_TAGS),
    annualFirst(cik10, "us-gaap", CASH_TAGS),
    annualFirst(cik10, "us-gaap", SHARES_TAGS),
  ]);

  const view = buildFinancials(
    {
      revenue,
      netIncome,
      eps,
      equity,
      sharesOut: shares.at(-1)?.val ?? null,
      ocf,
      capex,
      debt,
      cash,
      shares: dilutedShares,
    },
    now,
  );
  memo.set(cik10, { at: now, value: view });
  return view;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Cifras grandes legibles: 96.2B, 1.4T, 350M. */
function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${round(n / 1e12, 2)}T`;
  if (abs >= 1e9) return `${round(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${round(n / 1e6, 1)}M`;
  return String(Math.round(n));
}
