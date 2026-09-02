import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { assets, transactions, type Snapshot } from "@/db/schema";
import { isIsoDate, todayUtc, type ResolvedPeriod } from "./period";
import type { PortfolioSummary } from "./portfolio";
import { firstSnapshot, snapshotsAround } from "./snapshot";

/**
 * Que paso con la cartera en un periodo. Sale de los snapshots diarios (no
 * hay precios historicos de todo) mas los dividendos del libro:
 *
 *   resultado = (P&L al final − P&L al inicio) + dividendos del periodo
 *
 * donde P&L = no realizado + realizado. Es independiente de lo que hayas
 * metido o sacado: un deposito sube el valor pero no el resultado. El punto de
 * partida es el cierre del dia ANTERIOR al periodo; el final es el ultimo
 * cierre del periodo, o los precios en vivo si el periodo llega a hoy.
 */

export type GroupKey = "all" | "bolsa" | "cripto";

export const GROUP_CLASSES: Record<GroupKey, string[] | null> = {
  all: null,
  bolsa: ["equity", "etf"],
  cripto: ["crypto"],
};

export type PeriodPoint = {
  date: string;
  value: number;
  /** Resultado acumulado desde el inicio del periodo (null si no se puede medir). */
  result: number | null;
  /** Capital propio: valor − P&L total. Sube con un deposito, no con una subida. */
  capital: number | null;
};

export type PeriodMover = {
  assetId: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  group: string;
  quantity: number;
  priceStart: number;
  price: number;
  /** Variacion en dinero con la cantidad actual: cantidad × (precio − precio inicial). */
  change: number;
  changePct: number;
};

/** `pnl` es el P&L total (no realizado + realizado + dividendos acumulados). */
export type PeriodEdge = { date: string; value: number; pnl: number | null };

export type PeriodMetrics = {
  from: string;
  to: string;
  /** Cierre del ultimo dia anterior al periodo; si no hay, el primer cierre dentro (partial). */
  start: PeriodEdge | null;
  end: (PeriodEdge & { live: boolean }) | null;
  /** El historico empieza despues de `from`: el resultado cubre solo desde start.date. */
  partial: boolean;
  result: number | null;
  resultPct: number | null;
  valueChange: number | null;
  dividends: number;
  chart: PeriodPoint[];
  movers: PeriodMover[];
};

export type DashboardPeriod = {
  period: ResolvedPeriod;
  groups: Record<GroupKey, PeriodMetrics>;
  comparison: Record<GroupKey, PeriodMetrics> | null;
  firstSnapshotDate: string | null;
};

export type DividendRow = { assetClass: string; amount: number; executedAt: number };

// ---------------------------------------------------------------------------
// Lectura del breakdown de un snapshot (tolerante con versiones viejas)

type SnapClass = { assetClass: string; value: number; unrealizedPnl: number; realizedPnl?: number; dividends?: number };
type SnapPosition = {
  assetId?: string;
  symbol: string;
  assetClass?: string;
  group?: string;
  value: number;
  quantity: number;
  price: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
};

function breakdownOf(s: Snapshot): { byClass: SnapClass[]; positions: SnapPosition[] } {
  try {
    const j = JSON.parse(s.breakdown) as { byClass?: SnapClass[]; positions?: SnapPosition[] };
    return { byClass: Array.isArray(j.byClass) ? j.byClass : [], positions: Array.isArray(j.positions) ? j.positions : [] };
  } catch {
    return { byClass: [], positions: [] };
  }
}

function inGroup(group: GroupKey, assetClass: string): boolean {
  const classes = GROUP_CLASSES[group];
  return classes === null || classes.includes(assetClass);
}

/** Valor y P&L (no realizado + realizado) de un snapshot para un grupo. */
function edgeOf(s: Snapshot, group: GroupKey): PeriodEdge {
  if (group === "all") return { date: s.date, value: s.totalValue, pnl: s.unrealizedPnl + s.realizedPnl };
  const { byClass } = breakdownOf(s);
  let value = 0;
  let pnl: number | null = 0;
  for (const c of byClass) {
    if (!inGroup(group, c.assetClass)) continue;
    value += c.value;
    // Snapshots anteriores a esta version no guardan el realizado por clase:
    // sin el, la diferencia de P&L entre dos dias no significa nada.
    if (typeof c.realizedPnl !== "number") pnl = null;
    else if (pnl !== null) pnl += c.unrealizedPnl + c.realizedPnl;
  }
  return { date: s.date, value, pnl };
}

function liveEdge(live: PortfolioSummary, group: GroupKey, date: string): PeriodEdge & { live: true } {
  const open = live.positions.filter((p) => inGroup(group, p.group));
  const closed = live.closed.filter((p) => inGroup(group, p.group));
  const value = open.reduce((a, p) => a + p.value, 0);
  const pnl = [...open, ...closed].reduce((a, p) => a + p.realizedPnl, 0) + open.reduce((a, p) => a + p.unrealizedPnl, 0);
  return { date, value, pnl, live: true };
}

/**
 * Un snapshot vale para medir si tiene posiciones y sus precios llegaron.
 * Los primeros dias de una cuenta salen fotos vacias (antes de sincronizar)
 * o con precios a 0 (proveedor caido): compararse con ellas presenta
 * depositos como ganancia o hundimientos que no existieron.
 */
export function isReliableSnapshot(s: Snapshot): boolean {
  const { byClass, positions } = breakdownOf(s);
  if (positions.length === 0 || s.totalValue <= 0) return false;
  let held = 0;
  let unpriced = 0;
  for (const p of positions) {
    if (p.quantity <= 0) continue;
    held++;
    if (p.price > 0) continue;
    unpriced++;
    // Con coste conocido (formato nuevo): una posicion sin precio que valia
    // algo es un proveedor caido, no polvo sin cotizacion.
    if (typeof p.unrealizedPnl === "number" && p.unrealizedPnl < -100) return false;
  }
  // Formato viejo (sin coste por posicion): si falta el precio de una parte
  // grande de la cartera, la foto no vale. El polvo sin cotizacion (una o dos
  // monedas residuales) pasa.
  if (held > 0 && unpriced / held > 0.25) return false;
  for (const c of byClass) {
    if (c.value <= 0 && c.unrealizedPnl < -100) return false;
  }
  return true;
}

/** Dividendos acumulados hasta el final de un dia (o hasta un instante). */
function dividendsUntil(dividends: DividendRow[], group: GroupKey, untilMs: number): number {
  let total = 0;
  for (const d of dividends) {
    if (d.executedAt <= untilMs && inGroup(group, d.assetClass)) total += d.amount;
  }
  return total;
}

const endOfDay = (iso: string) => Date.parse(`${iso}T23:59:59.999Z`);

// ---------------------------------------------------------------------------

/**
 * Calculo puro. `snaps` trae el ultimo snapshot anterior a `from` (si existe)
 * y los de dentro del rango, en orden; los que no son fiables se ignoran.
 * `dividends` son todos los dividendos hasta `to`. `live` se usa como cierre
 * cuando el rango llega a `liveDate` (el "hoy" del usuario).
 */
export function computePeriod(
  range: { from: string; to: string },
  group: GroupKey,
  snaps: Snapshot[],
  live: PortfolioSummary | null,
  dividends: DividendRow[],
  liveDate: string,
): PeriodMetrics {
  const usable = snaps.filter(isReliableSnapshot);
  const before = usable.filter((s) => s.date < range.from).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  const inside = usable.filter((s) => s.date >= range.from && s.date <= range.to).sort((a, b) => (a.date < b.date ? -1 : 1));

  // P&L total de un cierre: no realizado + realizado + dividendos acumulados.
  const totalPnl = (e: PeriodEdge, untilMs: number): number | null =>
    e.pnl === null ? null : e.pnl + dividendsUntil(dividends, group, untilMs);
  const closeOf = (snap: Snapshot): PeriodEdge => {
    const e = edgeOf(snap, group);
    return { ...e, pnl: totalPnl(e, endOfDay(snap.date)) };
  };

  const startSnap = before ?? inside[0] ?? null;
  const partial = !before && inside.length > 0;
  const start = startSnap ? closeOf(startSnap) : null;

  const isLive = live !== null && range.to >= liveDate;
  const lastInside = inside.length > 0 ? inside[inside.length - 1] : null;
  // Sin cierre distinto del de partida no hay tramo que medir.
  let end: PeriodMetrics["end"] = null;
  if (isLive) {
    const e = liveEdge(live, group, range.to);
    end = { ...e, pnl: totalPnl(e, Number.MAX_SAFE_INTEGER) };
  } else if (lastInside && lastInside !== startSnap) {
    end = { ...closeOf(lastInside), live: false };
  }

  // Dividendos del tramo medido (informativo: ya van dentro del P&L total).
  const measuredFrom = start && start.date > range.from ? start.date : range.from;
  const divFrom = Date.parse(`${measuredFrom}T00:00:00Z`);
  const divTo = endOfDay(range.to);
  const divs = dividends
    .filter((d) => inGroup(group, d.assetClass) && d.executedAt >= divFrom && d.executedAt <= divTo)
    .reduce((a, d) => a + d.amount, 0);

  const hasPnl = start !== null && end !== null && start.pnl !== null && end.pnl !== null;
  const result = hasPnl ? end!.pnl! - start!.pnl! : null;
  const resultPct = result !== null && start!.value > 0 ? (result / start!.value) * 100 : null;
  const valueChange = start && end ? end.value - start.value : null;

  // Grafico: el punto de partida + los cierres del rango (+ el vivo al final).
  // `result` es relativo al inicio del periodo; `capital` = valor − P&L total,
  // asi que un deposito mueve valor y capital por igual y el resultado no.
  const chart: PeriodPoint[] = [];
  const basePnl = start?.pnl ?? null;
  const pointOf = (e: PeriodEdge): PeriodPoint => ({
    date: e.date,
    value: e.value,
    result: e.pnl !== null && basePnl !== null ? e.pnl - basePnl : null,
    capital: e.pnl !== null ? e.value - e.pnl : null,
  });
  if (before) chart.push(pointOf(closeOf(before)));
  for (const s of inside) chart.push(pointOf(closeOf(s)));
  if (isLive && end) {
    const point = pointOf(end);
    if (chart.length > 0 && chart[chart.length - 1].date === range.to) chart[chart.length - 1] = point;
    else chart.push(point);
  }

  // Mejores y peores por variacion de precio en el periodo.
  const movers: PeriodMover[] = [];
  if (startSnap && end) {
    const startPositions = breakdownOf(startSnap).positions;
    const byId = new Map<string, SnapPosition>();
    const bySymbol = new Map<string, SnapPosition>();
    for (const sp of startPositions) {
      if (sp.assetId) byId.set(sp.assetId, sp);
      bySymbol.set(sp.symbol.toUpperCase(), sp);
    }
    if (isLive) {
      for (const p of live.positions) {
        if (p.asset.assetClass === "cash" || !inGroup(group, p.group) || p.price <= 0) continue;
        const sp = byId.get(p.asset.id) ?? (byId.size === 0 ? bySymbol.get(p.asset.symbol.toUpperCase()) : undefined);
        if (!sp || sp.price <= 0) continue;
        movers.push({
          assetId: p.asset.id,
          symbol: p.asset.symbol,
          name: p.asset.name,
          logoUrl: p.asset.logoUrl,
          group: p.group,
          quantity: p.quantity,
          priceStart: sp.price,
          price: p.price,
          change: p.quantity * (p.price - sp.price),
          changePct: (p.price / sp.price - 1) * 100,
        });
      }
    } else if (lastInside) {
      for (const ep of breakdownOf(lastInside).positions) {
        const g = ep.group ?? "";
        if (!ep.assetId || ep.assetClass === "cash" || !inGroup(group, g) || ep.price <= 0) continue;
        const sp = byId.get(ep.assetId);
        if (!sp || sp.price <= 0) continue;
        movers.push({
          assetId: ep.assetId,
          symbol: ep.symbol,
          name: ep.symbol,
          logoUrl: null,
          group: g,
          quantity: ep.quantity,
          priceStart: sp.price,
          price: ep.price,
          change: ep.quantity * (ep.price - sp.price),
          changePct: (ep.price / sp.price - 1) * 100,
        });
      }
    }
    movers.sort((a, b) => b.changePct - a.changePct);
  }

  return { from: range.from, to: range.to, start, end, partial, result, resultPct, valueChange, dividends: divs, chart, movers };
}

// ---------------------------------------------------------------------------
// Con datos reales

/** Todos los dividendos hasta el fin del rango: hacen falta acumulados. */
async function dividendsUpTo(to: string): Promise<DividendRow[]> {
  const rows = await db
    .select({ tx: transactions, assetClass: assets.assetClass })
    .from(transactions)
    .innerJoin(assets, eq(transactions.assetId, assets.id))
    .where(and(eq(transactions.type, "dividend"), lte(transactions.executedAt, endOfDay(to))));
  return rows.map(({ tx, assetClass }) => {
    const gross = Math.abs(tx.quantity) * tx.price;
    return { assetClass, amount: gross > 0 ? gross : tx.price, executedAt: tx.executedAt };
  });
}

async function metricsFor(
  range: { from: string; to: string },
  live: PortfolioSummary,
  liveDate: string,
): Promise<Record<GroupKey, PeriodMetrics>> {
  const [snaps, divs] = await Promise.all([snapshotsAround(range.from, range.to), dividendsUpTo(range.to)]);
  return {
    all: computePeriod(range, "all", snaps, live, divs, liveDate),
    bolsa: computePeriod(range, "bolsa", snaps, live, divs, liveDate),
    cripto: computePeriod(range, "cripto", snaps, live, divs, liveDate),
  };
}

/** Todo lo que necesita el Resumen para un periodo (y su comparacion). */
export async function dashboardPeriod(
  period: ResolvedPeriod,
  live: PortfolioSummary,
  clientToday?: string,
): Promise<DashboardPeriod> {
  const liveDate = isIsoDate(clientToday) ? clientToday : todayUtc();
  const [groups, comparison, first] = await Promise.all([
    metricsFor(period, live, liveDate),
    period.cmpFrom && period.cmpTo ? metricsFor({ from: period.cmpFrom, to: period.cmpTo }, live, liveDate) : Promise.resolve(null),
    firstSnapshot().catch(() => null),
  ]);
  return { period, groups, comparison, firstSnapshotDate: first?.date ?? null };
}
