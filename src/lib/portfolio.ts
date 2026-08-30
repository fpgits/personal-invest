import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, transactions, type Asset, type Transaction } from "@/db/schema";
import { getQuotes, type CachedQuote } from "./market";
import { resolveBaseCurrency, resolveCostMethod } from "./settings";

export type Position = {
  asset: Asset;
  quantity: number;
  /** Coste medio por unidad de lo que sigues teniendo. */
  avgCost: number;
  costBasis: number;
  price: number;
  value: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  realizedPnl: number;
  dividends: number;
  fees: number;
  dayChange: number;
  dayChangePct: number;
  /** Peso sobre el total de la cartera, en %. */
  weight: number;
  priceStale: boolean;
  priceUpdatedAt: number | null;
};

export type ClassBreakdown = {
  assetClass: string;
  value: number;
  weight: number;
  unrealizedPnl: number;
};

export type PortfolioSummary = {
  currency: string;
  totalValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  realizedPnl: number;
  dividends: number;
  fees: number;
  dayChange: number;
  dayChangePct: number;
  positions: Position[];
  closed: Position[];
  byClass: ClassBreakdown[];
  /** true si algun precio no se pudo refrescar. */
  degraded: boolean;
};

type Lot = { qty: number; cost: number };

type Acc = {
  quantity: number;
  costBasis: number;
  realized: number;
  dividends: number;
  fees: number;
  lots: Lot[];
};

function emptyAcc(): Acc {
  return { quantity: 0, costBasis: 0, realized: 0, dividends: 0, fees: 0, lots: [] };
}

const EPS = 1e-9;

/**
 * Aplica una transaccion al acumulador de un activo.
 *
 * average: el coste medio se recalcula en cada compra y las ventas realizan
 * P&L contra ese medio.
 * fifo: se mantienen lotes y las ventas consumen los mas antiguos primero.
 */
function apply(acc: Acc, tx: Transaction, method: "average" | "fifo") {
  const qty = Math.abs(tx.quantity);
  const gross = qty * tx.price;

  switch (tx.type) {
    case "buy":
    case "transfer_in": {
      // Una transferencia entrante sin precio entra con coste 0: no inventamos
      // un coste que no conocemos, y queda visible como P&L al venderla.
      const cost = gross + tx.fee;
      acc.quantity += qty;
      acc.costBasis += cost;
      acc.fees += tx.fee;
      acc.lots.push({ qty, cost: qty > 0 ? cost / qty : 0 });
      break;
    }

    case "sell":
    case "transfer_out": {
      const sellable = Math.min(qty, acc.quantity);
      if (sellable <= EPS) break;

      let costOut = 0;
      if (method === "fifo") {
        let left = sellable;
        while (left > EPS && acc.lots.length > 0) {
          const lot = acc.lots[0];
          const take = Math.min(lot.qty, left);
          costOut += take * lot.cost;
          lot.qty -= take;
          left -= take;
          if (lot.qty <= EPS) acc.lots.shift();
        }
      } else {
        const avg = acc.quantity > EPS ? acc.costBasis / acc.quantity : 0;
        costOut = avg * sellable;
        // Mantenemos los lotes consistentes por si se cambia de metodo.
        let left = sellable;
        while (left > EPS && acc.lots.length > 0) {
          const lot = acc.lots[0];
          const take = Math.min(lot.qty, left);
          lot.qty -= take;
          left -= take;
          if (lot.qty <= EPS) acc.lots.shift();
        }
      }

      // Una salida por transferencia no realiza P&L: el activo sigue siendo tuyo.
      const proceeds = tx.type === "sell" ? sellable * tx.price - tx.fee : costOut;
      acc.realized += proceeds - costOut;
      acc.quantity -= sellable;
      acc.costBasis -= costOut;
      acc.fees += tx.fee;
      if (acc.quantity <= EPS) {
        acc.quantity = 0;
        acc.costBasis = 0;
        acc.lots = [];
      }
      break;
    }

    case "dividend": {
      // El importe va en price cuando quantity es 1, o en quantity*price.
      acc.dividends += gross > 0 ? gross : tx.price;
      acc.fees += tx.fee;
      break;
    }

    case "fee": {
      acc.fees += tx.fee || gross;
      acc.realized -= tx.fee || gross;
      break;
    }
  }
}

export async function computePortfolio(): Promise<PortfolioSummary> {
  const [method, currency] = await Promise.all([
    resolveCostMethod(),
    resolveBaseCurrency(),
  ]);

  const rows = await db
    .select({ tx: transactions, asset: assets })
    .from(transactions)
    .innerJoin(assets, eq(transactions.assetId, assets.id))
    .orderBy(asc(transactions.executedAt));

  return buildSummary(rows, method, currency);
}

/**
 * Separado de la query para poder testearlo con datos en memoria.
 * `quoteProvider` se inyecta en los tests para no depender de la red.
 */
export async function buildSummary(
  rows: Array<{ tx: Transaction; asset: Asset }>,
  method: "average" | "fifo",
  currency: string,
  quoteProvider: (
    held: Asset[],
  ) => Promise<Record<string, CachedQuote>> = (held) =>
    getQuotes(held).catch(() => ({}) as Record<string, CachedQuote>),
): Promise<PortfolioSummary> {
  const accs = new Map<string, Acc>();
  const assetById = new Map<string, Asset>();

  for (const { tx, asset } of rows) {
    assetById.set(asset.id, asset);
    if (!accs.has(asset.id)) accs.set(asset.id, emptyAcc());
    apply(accs.get(asset.id)!, tx, method);
  }

  const held = [...assetById.values()].filter(
    (a) => (accs.get(a.id)?.quantity ?? 0) > EPS,
  );
  const quotes = await quoteProvider(held);

  const open: Position[] = [];
  const closed: Position[] = [];
  let totalValue = 0;

  for (const [assetId, acc] of accs) {
    const asset = assetById.get(assetId)!;
    const q = quotes[assetId];
    const price = q?.price ?? 0;
    const value = acc.quantity * price;
    const avgCost = acc.quantity > EPS ? acc.costBasis / acc.quantity : 0;
    const unrealized = acc.quantity > EPS ? value - acc.costBasis : 0;

    const pos: Position = {
      asset,
      quantity: acc.quantity,
      avgCost,
      costBasis: acc.costBasis,
      price,
      value,
      unrealizedPnl: unrealized,
      unrealizedPct: acc.costBasis > EPS ? (unrealized / acc.costBasis) * 100 : 0,
      realizedPnl: acc.realized,
      dividends: acc.dividends,
      fees: acc.fees,
      dayChange: acc.quantity * (q?.change ?? 0),
      dayChangePct: q?.changePct ?? 0,
      weight: 0,
      priceStale: q?.stale ?? true,
      priceUpdatedAt: q?.updatedAt ?? null,
    };

    if (acc.quantity > EPS) {
      totalValue += value;
      open.push(pos);
    } else if (
      Math.abs(acc.realized) > EPS ||
      acc.dividends > EPS ||
      acc.fees > EPS
    ) {
      closed.push(pos);
    }
  }

  for (const p of open) {
    p.weight = totalValue > EPS ? (p.value / totalValue) * 100 : 0;
  }
  open.sort((a, b) => b.value - a.value);
  closed.sort((a, b) => b.realizedPnl - a.realizedPnl);

  const costBasis = open.reduce((s, p) => s + p.costBasis, 0);
  const unrealizedPnl = open.reduce((s, p) => s + p.unrealizedPnl, 0);
  const realizedPnl = [...open, ...closed].reduce((s, p) => s + p.realizedPnl, 0);
  const dividends = [...open, ...closed].reduce((s, p) => s + p.dividends, 0);
  const fees = [...open, ...closed].reduce((s, p) => s + p.fees, 0);
  const dayChange = open.reduce((s, p) => s + p.dayChange, 0);

  const classMap = new Map<string, { value: number; pnl: number }>();
  for (const p of open) {
    const k = p.asset.assetClass;
    const cur = classMap.get(k) ?? { value: 0, pnl: 0 };
    cur.value += p.value;
    cur.pnl += p.unrealizedPnl;
    classMap.set(k, cur);
  }

  return {
    currency,
    totalValue,
    costBasis,
    unrealizedPnl,
    unrealizedPct: costBasis > EPS ? (unrealizedPnl / costBasis) * 100 : 0,
    realizedPnl,
    dividends,
    fees,
    dayChange,
    dayChangePct:
      totalValue - dayChange > EPS
        ? (dayChange / (totalValue - dayChange)) * 100
        : 0,
    positions: open,
    closed,
    byClass: [...classMap.entries()]
      .map(([assetClass, v]) => ({
        assetClass,
        value: v.value,
        weight: totalValue > EPS ? (v.value / totalValue) * 100 : 0,
        unrealizedPnl: v.pnl,
      }))
      .sort((a, b) => b.value - a.value),
    degraded: open.some((p) => p.priceStale),
  };
}
