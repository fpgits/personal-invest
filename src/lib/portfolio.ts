import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  assets,
  transactions,
  type Asset,
  type Transaction,
} from "@/db/schema";
import { getCachedQuotes, getQuotes, type CachedQuote } from "./market";
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
  /**
   * true si parte de la cantidad entro como transferencia sin precio (deposito
   * de origen desconocido). Su coste se estima al precio actual, asi que el P&L
   * de esa parte es ~0 y el usuario deberia fijar el coste real si lo sabe.
   */
  costEstimated: boolean;
  /**
   * Clase para agrupar en la UI. Casi siempre es assetClass, pero el EFECTIVO
   * cuenta en el lado de su cuenta: el USDT de un exchange va con "crypto", el
   * USD de un broker va con "equity". Asi el cash no es un cajon aparte.
   */
  group: string;
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
  /** Cantidad recibida sin precio (deposito): coste desconocido, aparte. */
  unknownQty: number;
};

function emptyAcc(): Acc {
  return {
    quantity: 0,
    costBasis: 0,
    realized: 0,
    dividends: 0,
    fees: 0,
    lots: [],
    unknownQty: 0,
  };
}

const EPS = 1e-9;

const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDP", "PYUSD", "USDD", "GUSD",
]);

/**
 * A que lado pertenece una posicion al agrupar (Bolsa vs Cripto). Lo normal es
 * su propia clase; el EFECTIVO se atribuye al lado de la cuenta donde vive:
 * exchange -> cripto, broker -> bolsa. Sin dato de cuenta, cae al tipo de
 * moneda (stablecoin -> cripto, divisa -> bolsa).
 */
function groupFor(asset: Asset, accountType?: string | null): string {
  if (asset.assetClass !== "cash") return asset.assetClass;
  if (accountType === "exchange") return "crypto";
  if (accountType === "broker") return "equity";
  return STABLECOINS.has(asset.symbol.toUpperCase()) ? "crypto" : "equity";
}

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
      // transfer_in sin precio = coste DESCONOCIDO. No lo metemos como coste 0
      // (eso haria que todo su valor pareciera ganancia): lo apartamos en
      // unknownQty y al valorar se estima al precio actual -> P&L neutro + aviso.
      if (tx.type === "transfer_in" && tx.price <= 0) {
        acc.unknownQty += qty;
        break;
      }
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

/**
 * `cacheOnly`: valora con el ultimo precio en cache sin refrescar nada. Lo
 * usan los procesos de fondo que solo necesitan pesos aproximados (p. ej. la
 * relevancia de cartera del motor de eventos) y no deben gastar tiempo ni
 * cuota de proveedores de precios.
 */
export async function computePortfolio(
  opts: { cacheOnly?: boolean } = {},
): Promise<PortfolioSummary> {
  const [method, currency] = await Promise.all([
    resolveCostMethod(),
    resolveBaseCurrency(),
  ]);

  const rows = await db
    .select({ tx: transactions, asset: assets, accountType: accounts.type })
    .from(transactions)
    .innerJoin(assets, eq(transactions.assetId, assets.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .orderBy(asc(transactions.executedAt));

  return buildSummary(
    rows,
    method,
    currency,
    opts.cacheOnly
      ? (held) => getCachedQuotes(held).catch(() => ({}) as Record<string, CachedQuote>)
      : undefined,
  );
}

/**
 * Separado de la query para poder testearlo con datos en memoria.
 * `quoteProvider` se inyecta en los tests para no depender de la red.
 */
export async function buildSummary(
  rows: Array<{ tx: Transaction; asset: Asset; accountType?: string | null }>,
  method: "average" | "fifo",
  currency: string,
  quoteProvider: (
    held: Asset[],
  ) => Promise<Record<string, CachedQuote>> = (held) =>
    getQuotes(held).catch(() => ({}) as Record<string, CachedQuote>),
): Promise<PortfolioSummary> {
  const accs = new Map<string, Acc>();
  const assetById = new Map<string, Asset>();
  // Tipo de cuenta por activo, para saber en que lado cae el efectivo.
  const accountTypeByAsset = new Map<string, string>();

  for (const { tx, asset, accountType } of rows) {
    assetById.set(asset.id, asset);
    if (accountType) accountTypeByAsset.set(asset.id, accountType);
    if (!accs.has(asset.id)) accs.set(asset.id, emptyAcc());
    apply(accs.get(asset.id)!, tx, method);
  }

  // El efectivo vale 1:1 y no se cotiza; se excluye de la consulta de precios.
  const held = [...assetById.values()].filter((a) => {
    if (a.assetClass === "cash") return false;
    const acc = accs.get(a.id);
    return ((acc?.quantity ?? 0) + (acc?.unknownQty ?? 0)) > EPS;
  });
  const quotes = await quoteProvider(held);

  const open: Position[] = [];
  const closed: Position[] = [];
  let totalValue = 0;

  for (const [assetId, acc] of accs) {
    const asset = assetById.get(assetId)!;
    // El efectivo (USDT, USD...) vale 1:1 y nunca esta "desactualizado".
    const isCashAsset = asset.assetClass === "cash";
    const q = quotes[assetId];
    const price = isCashAsset ? 1 : q?.price ?? 0;

    // Cantidad total = lo de coste conocido + los depositos sin precio.
    const quantity = acc.quantity + acc.unknownQty;
    const value = quantity * price;

    // La parte de coste desconocido se estima al precio actual: asi su P&L es
    // ~0 en vez de fingir que todo su valor es ganancia. El resto conserva su
    // coste real, asi que el P&L refleja solo la parte que si sabemos.
    const estimatedCost = acc.unknownQty * price;
    const costBasis = acc.costBasis + estimatedCost;
    const costEstimated = acc.unknownQty > EPS;

    const avgCost = quantity > EPS ? costBasis / quantity : 0;
    const unrealized = quantity > EPS ? value - costBasis : 0;

    const pos: Position = {
      asset,
      quantity,
      avgCost,
      costBasis,
      price,
      value,
      unrealizedPnl: unrealized,
      unrealizedPct: costBasis > EPS ? (unrealized / costBasis) * 100 : 0,
      realizedPnl: acc.realized,
      dividends: acc.dividends,
      fees: acc.fees,
      dayChange: quantity * (q?.change ?? 0),
      dayChangePct: q?.changePct ?? 0,
      weight: 0,
      priceStale: isCashAsset ? false : q?.stale ?? true,
      priceUpdatedAt: q?.updatedAt ?? null,
      costEstimated,
      group: groupFor(asset, accountTypeByAsset.get(assetId)),
    };

    if (quantity > EPS) {
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

  // Reparto por "lado": el efectivo ya viene atribuido a bolsa o cripto via
  // p.group, asi que no aparece como una clase separada.
  const classMap = new Map<string, { value: number; pnl: number }>();
  for (const p of open) {
    const k = p.group;
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
