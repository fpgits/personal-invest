import { asc, eq, and, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  assets,
  snapshots,
  transactions,
  type Account,
  type Asset,
  type Snapshot,
  type Transaction,
} from "@/db/schema";
import { fetchStatement, type FlexEquityDay } from "./brokers/ibkr";
import { decrypt } from "./crypto";
import { coingecko, type CachedQuote } from "./market";
import { dailyCloses, type DailyClose } from "./market/stooq";
import { addDays, daysBetween, todayUtc } from "./period";
import { isReliableSnapshot } from "./period-metrics";
import { buildSummary, type PortfolioSummary } from "./portfolio";
import { resolveBaseCurrency, resolveCostMethod } from "./settings";
import { id } from "./utils";

/**
 * Reconstruccion del historico de la cartera para los dias en que la app aun
 * no fotografiaba nada (o la foto salio mal).
 *
 * Para cada dia se vuelve a jugar el libro de operaciones hasta ese dia con el
 * MISMO motor de P&L que usa el resto de la app, y se valora con los cierres
 * de ese dia: Stooq para acciones y ETF, CoinGecko para cripto. El efectivo
 * de dias pasados no esta en el libro (los ajustes de cuadre llevan la fecha
 * del sync), asi que sale del Equity Summary de IBKR si la Flex Query lo trae,
 * y si no se asume el saldo actual, constante. Nada de esto toca el resultado
 * (variacion del P&L): solo el valor y el capital aportado.
 *
 * Las fotos en vivo fiables nunca se pisan; las reconstruidas y las que
 * salieron mal, si.
 */

export const HISTORY_LIMITS = {
  /** Como maximo se reconstruye este numero de dias hacia atras. */
  maxDays: 365,
  /** Un cierre vale para los dias siguientes sin cierre (fin de semana, festivo). */
  closeLookbackDays: 10,
  /** El Equity Summary de IBKR vale para los dias siguientes sin fila. */
  equityLookbackDays: 5,
  pauseMs: 250,
} as const;

export type LedgerRow = { tx: Transaction; asset: Asset; accountType: string | null };

/** assetId → (YYYY-MM-DD → cierre). */
export type ClosesByAsset = Map<string, Map<string, number>>;

export type CashNow = { asset: Asset; amount: number; group: string; broker: boolean };

export type RebuildInput = {
  rows: LedgerRow[];
  method: "average" | "fifo";
  currency: string;
  from: string;
  to: string;
  closes: ClosesByAsset;
  /** Efectivo actual por activo de efectivo (USD del broker, USDT del exchange). */
  cashNow: CashNow[];
  /** Valor diario de la cuenta de IBKR, si la Flex Query lo trae. */
  equity: FlexEquityDay[];
};

export type RebuiltDay = {
  date: string;
  totalValue: number;
  costBasis: number;
  unrealizedPnl: number;
  realizedPnl: number;
  breakdown: string;
  /** Simbolos valorados sin cierre de ese dia (ultimo precio de operacion). */
  unpriced: string[];
  cashSource: "ibkr" | "current" | "none";
};

export type RebuildReport = {
  from: string;
  to: string;
  days: number;
  written: number;
  kept: number;
  /** simbolo → dias en los que no hubo cierre y se uso el ultimo precio de operacion. */
  unpriced: Record<string, number>;
  cashSource: "ibkr" | "current" | "none";
  closes: { symbol: string; points: number }[];
  errors: string[];
};

const RECONCILE = /reconcile/;
const endOfDay = (iso: string) => Date.parse(`${iso}T23:59:59.999Z`);

// ---------------------------------------------------------------------------
// Puro

/** Cierre de un dia (o el ultimo anterior dentro del margen). */
export function closeOn(series: Map<string, number> | undefined, date: string, lookback = HISTORY_LIMITS.closeLookbackDays): number | null {
  if (!series) return null;
  for (let i = 0; i <= lookback; i++) {
    const c = series.get(addDays(date, -i));
    if (c !== undefined && c > 0) return c;
  }
  return null;
}

/** Ultimo precio de operacion de un activo hasta un dia: respaldo cuando no hay cierre. */
function lastTradePrice(rows: LedgerRow[], assetId: string, untilMs: number): number {
  let price = 0;
  for (const r of rows) {
    if (r.asset.id !== assetId || r.tx.executedAt > untilMs) continue;
    if ((r.tx.type === "buy" || r.tx.type === "sell") && r.tx.price > 0) price = r.tx.price;
  }
  return price;
}

function equityOn(equity: FlexEquityDay[], date: string): FlexEquityDay | null {
  for (let i = 0; i <= HISTORY_LIMITS.equityLookbackDays; i++) {
    const d = addDays(date, -i);
    const row = equity.find((e) => e.date === d);
    if (row) return row;
  }
  return null;
}

/** Reconstruye un dia: libro hasta ese dia + cierres + efectivo. */
export async function rebuildDay(input: RebuildInput, date: string): Promise<RebuiltDay> {
  const untilMs = endOfDay(date);
  const rows = input.rows.filter((r) => r.tx.executedAt <= untilMs && !RECONCILE.test(r.tx.externalId ?? ""));
  const unpriced = new Set<string>();

  const provider = async (held: Asset[]): Promise<Record<string, CachedQuote>> => {
    const out: Record<string, CachedQuote> = {};
    for (const a of held) {
      let price = closeOn(input.closes.get(a.id), date);
      if (price === null) {
        price = lastTradePrice(rows, a.id, untilMs);
        unpriced.add(a.symbol);
      }
      out[a.id] = { price, change: 0, changePct: 0, currency: "USD", updatedAt: untilMs, stale: false };
    }
    return out;
  };

  const p: PortfolioSummary = await buildSummary(rows, input.method, input.currency, provider);

  // Efectivo del dia.
  const eq_ = equityOn(input.equity, date);
  let cashSource: RebuiltDay["cashSource"] = input.cashNow.length > 0 ? "current" : "none";
  const cashPositions = input.cashNow.map((c) => {
    let amount = c.amount;
    if (c.broker && eq_) {
      amount = eq_.cash;
      cashSource = "ibkr";
    }
    return {
      assetId: c.asset.id,
      symbol: c.asset.symbol,
      assetClass: "cash",
      group: c.group,
      value: amount,
      quantity: amount,
      price: 1,
      weight: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };
  });
  const cashTotal = cashPositions.reduce((a, c) => a + c.value, 0);
  const totalValue = p.totalValue + cashTotal;

  const byClass = p.byClass.map((c) => ({ ...c }));
  for (const c of cashPositions) {
    const cls = byClass.find((b) => b.assetClass === c.group);
    if (cls) cls.value += c.value;
    else byClass.push({ assetClass: c.group, value: c.value, weight: 0, unrealizedPnl: 0, realizedPnl: 0, dividends: 0 });
  }
  for (const c of byClass) c.weight = totalValue > 0 ? (c.value / totalValue) * 100 : 0;
  byClass.sort((a, b) => b.value - a.value);

  const positions = [
    ...p.positions.map((x) => ({
      assetId: x.asset.id,
      symbol: x.asset.symbol,
      assetClass: x.asset.assetClass,
      group: x.group,
      value: x.value,
      quantity: x.quantity,
      price: x.price,
      weight: totalValue > 0 ? (x.value / totalValue) * 100 : 0,
      unrealizedPnl: x.unrealizedPnl,
      realizedPnl: x.realizedPnl,
    })),
    ...cashPositions.map((c) => ({ ...c, weight: totalValue > 0 ? (c.value / totalValue) * 100 : 0 })),
  ];

  return {
    date,
    totalValue,
    costBasis: p.costBasis + cashTotal,
    unrealizedPnl: p.unrealizedPnl,
    realizedPnl: p.realizedPnl,
    breakdown: JSON.stringify({
      byClass,
      positions,
      meta: { source: "rebuilt", unpriced: [...unpriced], cashSource, broker: eq_ ? { cash: eq_.cash, stock: eq_.stock, total: eq_.total } : null },
    }),
    unpriced: [...unpriced],
    cashSource,
  };
}

/** Todos los dias del rango, del mas viejo al mas nuevo. */
export async function rebuildDays(input: RebuildInput): Promise<RebuiltDay[]> {
  const out: RebuiltDay[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    out.push(await rebuildDay(input, d));
  }
  return out;
}

/** Serie CoinGecko (puntos a las 00:00 UTC) → cierre del dia ANTERIOR a cada punto. */
export function coingeckoToCloses(points: Array<{ t: number; c: number }>): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!(p.c > 0)) continue;
    const date = new Date(p.t - 60_000).toISOString().slice(0, 10);
    byDate.set(date, p.c);
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Con red y DB (inyectable)

export type HistoryDeps = {
  equityCloses: (symbol: string, from: string, to: string) => Promise<DailyClose[]>;
  cryptoCloses: (providerId: string, days: number) => Promise<DailyClose[]>;
  brokerEquity: (account: Account) => Promise<FlexEquityDay[]>;
  now: () => number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const defaultDeps: HistoryDeps = {
  equityCloses: dailyCloses,
  cryptoCloses: async (providerId, days) => coingeckoToCloses(await coingecko.chart(providerId, days)),
  brokerEquity: async (account) => {
    if (!account.apiKeyEnc || !account.flexQueryId) return [];
    const st = await fetchStatement(decrypt(account.apiKeyEnc), account.flexQueryId);
    return st.equitySummary;
  },
  now: () => Date.now(),
};

/**
 * Reconstruye el historico hasta ayer. Idempotente: se puede lanzar cuantas
 * veces se quiera; solo pisa fotos reconstruidas o no fiables.
 */
export async function rebuildHistory(deps: Partial<HistoryDeps> = {}): Promise<RebuildReport> {
  const D = { ...defaultDeps, ...deps };
  const today = todayUtc(new Date(D.now()));
  const errors: string[] = [];

  const [method, currency] = await Promise.all([resolveCostMethod(), resolveBaseCurrency()]);
  const rows: LedgerRow[] = await db
    .select({ tx: transactions, asset: assets, accountType: accounts.type })
    .from(transactions)
    .innerJoin(assets, eq(transactions.assetId, assets.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .orderBy(asc(transactions.executedAt));

  const real = rows.filter((r) => !RECONCILE.test(r.tx.externalId ?? ""));
  if (real.length === 0) {
    return { from: today, to: today, days: 0, written: 0, kept: 0, unpriced: {}, cashSource: "none", closes: [], errors: ["No hay operaciones en el libro"] };
  }

  const firstDay = new Date(real[0].tx.executedAt).toISOString().slice(0, 10);
  const floor = addDays(today, -HISTORY_LIMITS.maxDays);
  const from = firstDay > floor ? firstDay : floor;
  const to = addDays(today, -1);
  if (from > to) {
    return { from, to, days: 0, written: 0, kept: 0, unpriced: {}, cashSource: "none", closes: [], errors: [] };
  }

  // Cierres de todo lo que aparece en el libro (sin ajustes de cuadre).
  const closes: ClosesByAsset = new Map();
  const closesReport: RebuildReport["closes"] = [];
  const seen = new Map<string, Asset>();
  for (const r of real) if (r.asset.assetClass !== "cash") seen.set(r.asset.id, r.asset);
  const days = daysBetween(from, today);
  for (const a of seen.values()) {
    try {
      const series =
        a.assetClass === "crypto"
          ? await D.cryptoCloses(a.providerId || a.symbol.toLowerCase(), Math.min(365, days + 1))
          : await D.equityCloses(a.providerId || a.symbol, addDays(from, -HISTORY_LIMITS.closeLookbackDays), to);
      closes.set(a.id, new Map(series.map((s) => [s.date, s.close])));
      closesReport.push({ symbol: a.symbol, points: series.length });
      if (series.length === 0) errors.push(`${a.symbol}: sin cierres en la fuente`);
    } catch (e) {
      errors.push(`${a.symbol}: ${e instanceof Error ? e.message : String(e)}`);
      closesReport.push({ symbol: a.symbol, points: 0 });
    }
    await sleep(HISTORY_LIMITS.pauseMs);
  }

  // Sin ningun cierre de ninguna fuente, reconstruir seria inventar una linea
  // plana con los precios de compra: mejor no escribir nada y decirlo.
  if (seen.size > 0 && closesReport.every((c) => c.points === 0)) {
    return {
      from, to, days: 0, written: 0, kept: 0, unpriced: {}, cashSource: "none", closes: closesReport,
      errors: [...errors, "Ninguna fuente de cierres respondio: no se reconstruye nada"],
    };
  }

  // Efectivo actual (de los ajustes de cuadre de hoy) y valor diario de IBKR.
  const cashNow: CashNow[] = [];
  for (const r of rows) {
    if (r.asset.assetClass !== "cash" || r.tx.type !== "transfer_in" || !RECONCILE.test(r.tx.externalId ?? "")) continue;
    cashNow.push({
      asset: r.asset,
      amount: r.tx.quantity,
      group: r.accountType === "exchange" ? "crypto" : "equity",
      broker: r.accountType === "broker",
    });
  }
  let equity: FlexEquityDay[] = [];
  const brokers = await db.select().from(accounts).where(eq(accounts.type, "broker"));
  for (const b of brokers) {
    try {
      const rowsEq = await D.brokerEquity(b);
      if (rowsEq.length > 0) equity = rowsEq;
    } catch (e) {
      errors.push(`IBKR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const built = await rebuildDays({ rows, method, currency, from, to, closes, cashNow, equity });

  // Escritura: nunca pisar una foto en vivo fiable.
  const existing = await db
    .select()
    .from(snapshots)
    .where(and(gte(snapshots.date, from), lte(snapshots.date, to)));
  const byDate = new Map(existing.map((s) => [s.date, s]));
  let written = 0;
  let kept = 0;
  const unpriced: Record<string, number> = {};
  let cashSource: RebuildReport["cashSource"] = "none";
  for (const day of built) {
    for (const s of day.unpriced) unpriced[s] = (unpriced[s] ?? 0) + 1;
    if (day.cashSource === "ibkr") cashSource = "ibkr";
    else if (cashSource === "none" && day.cashSource === "current") cashSource = "current";
    const prev = byDate.get(day.date);
    if (prev && prev.source === "live" && isReliableSnapshot(prev)) {
      kept++;
      continue;
    }
    await db
      .insert(snapshots)
      .values({
        id: prev?.id ?? id(),
        date: day.date,
        totalValue: day.totalValue,
        costBasis: day.costBasis,
        unrealizedPnl: day.unrealizedPnl,
        realizedPnl: day.realizedPnl,
        breakdown: day.breakdown,
        source: "rebuilt",
        createdAt: D.now(),
      })
      .onConflictDoUpdate({
        target: snapshots.date,
        set: {
          totalValue: day.totalValue,
          costBasis: day.costBasis,
          unrealizedPnl: day.unrealizedPnl,
          realizedPnl: day.realizedPnl,
          breakdown: day.breakdown,
          source: "rebuilt",
        },
      });
    written++;
  }

  return { from, to, days: built.length, written, kept, unpriced, cashSource, closes: closesReport, errors };
}

export type HistorySummary = {
  total: number;
  live: number;
  rebuilt: number;
  unreliable: number;
  first: string | null;
  last: string | null;
  firstReliable: string | null;
};

/** Estado del historico para la pantalla de ajustes. */
export async function historySummary(): Promise<HistorySummary> {
  const rows = await db.select().from(snapshots).orderBy(asc(snapshots.date));
  const reliable = rows.filter(isReliableSnapshot);
  return {
    total: rows.length,
    live: rows.filter((r) => r.source === "live").length,
    rebuilt: rows.filter((r) => r.source === "rebuilt").length,
    unreliable: rows.length - reliable.length,
    first: rows[0]?.date ?? null,
    last: rows[rows.length - 1]?.date ?? null,
    firstReliable: reliable[0]?.date ?? null,
  };
}

/** Tipo exportado para los tests. */
export type { Snapshot };
