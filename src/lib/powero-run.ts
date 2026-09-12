import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { poweroMarks, poweroOrders, type PoweroOrder } from "@/db/schema-runups";
import { cachedMonthlyPlan } from "./conviction-run";
import { getCachedQuotes } from "./market";
import { datedCloses } from "./market/crypto-history";
import {
  buildBook,
  markBook,
  propose,
  signalFromLadder,
  signalFromVerdict,
  type Book,
  type BookMark,
  type Order,
  type Signal,
} from "./powero";
import { BENCHMARK, POWERO_KEYS, resolvePoweroSettings, type PoweroSettings } from "./powero-settings";
import { getSetting, setSetting } from "./settings";
import { id } from "./utils";

/**
 * PoWERo contra la base y el mercado. El nucleo de decision vive en powero.ts
 * y es puro; aqui solo se leen precios, se guardan ordenes y se apunta la
 * curva.
 *
 * Recordatorio que no sobra: nada de esto coloca una orden real. `executed`
 * significa "apuntado en el libro de mentira", nunca "comprado".
 */

export const BOOKS: Book[] = ["equity", "crypto"];

function toOrder(r: PoweroOrder): Order {
  return {
    id: r.id,
    book: r.book as Book,
    symbol: r.symbol,
    side: r.side as Order["side"],
    qty: r.qty,
    price: r.price,
    amount: r.amount,
    status: r.status as Order["status"],
    reason: r.reason ?? "",
    source: r.source,
    proposedAt: r.proposedAt,
    decidedAt: r.decidedAt,
  };
}

export async function listOrders(limit = 200): Promise<Order[]> {
  const rows = await db.select().from(poweroOrders).orderBy(desc(poweroOrders.proposedAt)).limit(limit);
  return rows.map(toOrder);
}

/** Precios de ahora para los simbolos que hagan falta. Mejor esfuerzo. */
async function pricesFor(symbols: string[]): Promise<Record<string, number | null>> {
  if (symbols.length === 0) return {};
  const rows = await db
    .select()
    .from(assets)
    .where(inArray(assets.symbol, symbols.map((s) => s.toUpperCase())))
    .catch(() => []);
  const quotes = await getCachedQuotes(rows).catch(() => ({}) as Awaited<ReturnType<typeof getCachedQuotes>>);
  const out: Record<string, number | null> = {};
  for (const a of rows) out[a.symbol] = quotes[a.id]?.price ?? null;
  for (const s of symbols) if (!(s in out)) out[s] = null;
  return out;
}

export type PoweroState = {
  settings: PoweroSettings;
  marks: Record<Book, BookMark>;
  orders: Order[];
  /** Propuestas vivas, esperando tu decision. */
  pending: Order[];
  curve: Array<{ at: number; equity: number; book: string }>;
  asOf: number;
};

const capitalOf = (s: PoweroSettings, book: Book) => (book === "equity" ? s.equityCapital : s.cryptoCapital);

/** Foto completa: libros valorados, registro y curva. */
export async function poweroState(now = Date.now()): Promise<PoweroState> {
  const settings = await resolvePoweroSettings();
  const orders = await listOrders(500);
  const symbols = [...new Set(orders.filter((o) => o.status === "executed").map((o) => o.symbol))];
  const prices = await pricesFor(symbols);

  const marks = {} as Record<Book, BookMark>;
  for (const book of BOOKS) {
    marks[book] = markBook(buildBook(book, capitalOf(settings, book), orders), prices);
  }

  const since = now - 90 * 86400_000;
  const curveRows = await db
    .select()
    .from(poweroMarks)
    .where(gte(poweroMarks.at, since))
    .orderBy(poweroMarks.at)
    .catch(() => []);

  return {
    settings,
    marks,
    orders,
    pending: orders.filter((o) => o.status === "proposed"),
    curve: curveRows.map((r) => ({ at: r.at, equity: r.equity, book: r.book })),
    asOf: now,
  };
}

/**
 * Traduce lo que el motor ya sabe a senales de PoWERo. Es el punto donde la
 * plataforma entera desemboca en una decision: veredicto de bolsa y escalera
 * cripto hoy; insiders, 13F y eventos cuando entren en el score.
 */
export async function collectSignals(): Promise<Signal[]> {
  const plan = await cachedMonthlyPlan().catch(() => null);
  if (!plan) return [];

  const priceOf = new Map(
    [...plan.run.holdings, ...plan.run.candidates].map((h) => [h.symbol, h.price > 0 ? h.price : null]),
  );
  const cryptoSymbols = new Set(plan.run.holdings.filter((h) => h.assetClass === "crypto").map((h) => h.symbol));

  const out: Signal[] = [];
  for (const v of plan.run.results) {
    if (cryptoSymbols.has(v.symbol)) continue;
    const s = signalFromVerdict({
      symbol: v.symbol,
      posture: v.posture,
      score: v.score,
      marginOfSafetyPct: v.marginOfSafetyPct,
      price: priceOf.get(v.symbol) ?? null,
      rationale: v.rationale,
    });
    if (s) out.push(s);
  }
  for (const l of plan.crypto.lines) {
    const s = signalFromLadder({
      symbol: l.symbol,
      multiplier: l.multiplier,
      confirmed: l.confirmed,
      price: l.stats?.price ?? null,
      reason: l.reason,
    });
    if (s) out.push(s);
  }
  return out;
}

/** Genera propuestas nuevas y las guarda. Devuelve las creadas. */
export async function proposeNow(now = Date.now()): Promise<Order[]> {
  const state = await poweroState(now);
  const signals = await collectSignals();
  // Sin duplicar: si ya hay una propuesta viva para ese simbolo y lado, se deja.
  const live = new Set(state.pending.map((o) => `${o.book}|${o.symbol}|${o.side}`));

  const created: Order[] = [];
  for (const book of BOOKS) {
    const orders = state.orders;
    const bookState = buildBook(book, capitalOf(state.settings, book), orders);
    const props = propose({
      state: bookState,
      mark: state.marks[book],
      signals: signals.filter((s) => s.book === book && !live.has(`${book}|${s.symbol}|${s.side}`)),
      now,
      makeId: id,
    });
    created.push(...props);
  }
  // Queda apuntado que el oraculo YA corrio, aunque no saliera nada. Sin esta
  // marca el reloj no sabria distinguir "hoy no habia nada que hacer" de "hoy
  // todavia no he mirado", y volveria a correrlo entero en cada pasada.
  await setSetting(POWERO_KEYS.lastProposeAt, String(now)).catch(() => undefined);
  if (created.length === 0) return [];

  const bySymbol = new Map(
    (await db.select().from(assets).catch(() => [])).map((a) => [a.symbol, a.id] as const),
  );
  await db.insert(poweroOrders).values(
    created.map((o) => ({
      id: o.id,
      book: o.book,
      symbol: o.symbol,
      assetId: bySymbol.get(o.symbol) ?? null,
      side: o.side,
      qty: o.qty,
      price: o.price,
      amount: o.amount,
      status: o.status,
      reason: o.reason,
      source: o.source,
      proposedAt: o.proposedAt,
      decidedAt: null,
    })),
  );

  // En modo auto la propuesta se apunta sola en el libro nocional. Sigue sin
  // tocar el broker: es para que la medicion no dependa de que tu estes.
  if (state.settings.mode === "auto") {
    await db
      .update(poweroOrders)
      .set({ status: "executed", decidedAt: now })
      .where(inArray(poweroOrders.id, created.map((o) => o.id)));
    return created.map((o) => ({ ...o, status: "executed" as const, decidedAt: now }));
  }
  return created;
}

/** Acepta o descarta una propuesta. Solo mueve el libro de mentira. */
export async function decide(orderId: string, decision: "executed" | "discarded", now = Date.now()): Promise<boolean> {
  const rows = await db
    .update(poweroOrders)
    .set({ status: decision, decidedAt: now })
    .where(and(eq(poweroOrders.id, orderId), eq(poweroOrders.status, "proposed")))
    .returning({ id: poweroOrders.id });
  return rows.length > 0;
}

/** El nombre del libro espejo que guarda la linea del indice. */
export const benchBook = (book: Book) => `bench_${book}`;

/**
 * La linea contra la que se mide: el mismo dinero, el mismo dia, metido en el
 * indice y quieto. Sin esto la curva de PoWERo no responde a la pregunta —
 * decir "+8%" no vale de nada si el indice hizo +12% en el mismo periodo. El
 * oraculo no compite contra cero, compite contra no hacer nada.
 *
 * Se compra UNA vez: la primera valoracion fija cuantas participaciones se
 * habrian comprado con el capital inicial, y a partir de ahi solo se revalora.
 */
/**
 * Precio del indice. Ojo con lo evidente: el indice NO tiene por que estar en
 * tu cartera — BTC no lo esta — y `pricesFor` solo sabe de activos tuyos. Si
 * no aparece por ahi, para cripto se pide el ultimo cierre directamente. Sin
 * esto la linea de comparacion de cripto no existiria y la curva de PoWERo se
 * quedaria sin contra quien medirse, que es justo lo que la hace util.
 */
async function benchmarkPrice(book: Book, symbol: string): Promise<number | null> {
  const prices = await pricesFor([symbol]).catch(() => ({}) as Record<string, number | null>);
  const own = prices[symbol] ?? null;
  if (own !== null && own > 0) return own;
  if (book !== "crypto") return null;
  const closes = await datedCloses(symbol, 3).catch(() => []);
  const last = closes.at(-1)?.close ?? null;
  return last !== null && Number.isFinite(last) && last > 0 ? last : null;
}

async function markBenchmark(book: Book, capital: number, now: number): Promise<number | null> {
  const symbol = BENCHMARK[book];
  const price = await benchmarkPrice(book, symbol);
  if (price === null || price <= 0) return null;

  const key = book === "equity" ? POWERO_KEYS.benchUnitsEquity : POWERO_KEYS.benchUnitsCrypto;
  const saved = Number(await getSetting(key).catch(() => null));
  let units = Number.isFinite(saved) && saved > 0 ? saved : 0;
  if (units === 0) {
    units = capital / price;
    await setSetting(key, String(units)).catch(() => undefined);
  }

  const equity = Math.round(units * price * 100) / 100;
  await db
    .insert(poweroMarks)
    .values({ id: id(), book: benchBook(book), at: now, cash: 0, positionsValue: equity, equity })
    .onConflictDoNothing();
  return equity;
}

/**
 * Apunta el patrimonio de cada libro y el del indice al mismo instante. De
 * estas filas salen las dos curvas.
 */
export async function markNow(now = Date.now()): Promise<Record<string, number>> {
  const state = await poweroState(now);
  const out: Record<string, number> = {};
  for (const book of BOOKS) {
    const m = state.marks[book];
    out[book] = m.equity;
    await db
      .insert(poweroMarks)
      .values({
        id: id(),
        book,
        at: now,
        cash: m.cash,
        positionsValue: m.positionsValue,
        equity: m.equity,
      })
      .onConflictDoNothing();

    const bench = await markBenchmark(book, capitalOf(state.settings, book), now).catch(() => null);
    if (bench !== null) out[benchBook(book)] = bench;
  }
  return out;
}

/** Empieza el libro de cero con el capital que haya en ajustes. */
export async function resetBook(book: Book): Promise<void> {
  await db.delete(poweroOrders).where(eq(poweroOrders.book, book));
  await db.delete(poweroMarks).where(eq(poweroMarks.book, book));
  // Y la linea del indice con el: si no, el libro nuevo se compararia contra
  // participaciones compradas en otra fecha y con otro capital.
  await db.delete(poweroMarks).where(eq(poweroMarks.book, benchBook(book)));
  await setSetting(
    book === "equity" ? POWERO_KEYS.benchUnitsEquity : POWERO_KEYS.benchUnitsCrypto,
    "0",
  ).catch(() => undefined);
}
