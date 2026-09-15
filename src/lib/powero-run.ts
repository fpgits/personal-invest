import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { poweroMarks, poweroOrders, type PoweroOrder } from "@/db/schema-runups";
import { cachedMonthlyPlan } from "./conviction-run";
import { getCachedQuotes } from "./market";
import { dailyCloses, datedCloses } from "./market/crypto-history";
import {
  attribute,
  buildBook,
  markBook,
  propose,
  signalFromLadder,
  signalFromPlanLine,
  signalFromTrim,
  signalFromVerdict,
  type Attribution,
  type Book,
  type BookMark,
  type Order,
  type Signal,
} from "./powero";
import {
  BENCHMARK,
  POWERO_KEYS,
  PROPOSE_MIN_GAP_MS,
  resolvePoweroSettings,
  type PoweroSettings,
} from "./powero-settings";
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

/**
 * Ultimo cierre de una cripto que no esta en `assets`. Dos intentos: primero
 * el barato (una peticion de velas), y si esa fuente no responde, el historico
 * largo — el MISMO que ya usa la escalera de ciclo, memoizado, asi que dentro
 * de una corrida del oraculo suele salir gratis y trae ademas la reserva de
 * CoinGecko cuando Binance no contesta.
 */
async function lastCryptoClose(symbol: string): Promise<number | null> {
  const ok = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const dated = await datedCloses(symbol, 3).catch(() => []);
  const quick = ok(dated.at(-1)?.close);
  if (quick !== null) return quick;
  const history = await dailyCloses(symbol).catch(() => null);
  return ok(history?.closes.at(-1));
}

/**
 * Precios de ahora para los simbolos que hagan falta. Mejor esfuerzo.
 *
 * Ojo con lo que no es evidente: `assets` son TUS activos, y PoWERo puede
 * perfectamente tener en el libro algo que tu no tienes — la escalera compro
 * BTC el primer dia, y BTC no esta en tu cartera. Sin la reserva de abajo, ese
 * simbolo se queda sin precio y `markBook` lo valora a coste: la linea no se
 * movería nunca y el libro mentiría en silencio, que es peor que fallar.
 *
 * `cryptoSymbols` dice cuales pueden pedirse al historico de cripto; para una
 * accion que no este en `assets` no hay reserva y se queda en null, visible.
 */
async function pricesFor(
  symbols: string[],
  cryptoSymbols: Set<string> = new Set(),
): Promise<Record<string, number | null>> {
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

  const missing = symbols.filter((s) => (out[s] ?? null) === null && cryptoSymbols.has(s));
  await Promise.all(missing.map(async (s) => (out[s] = await lastCryptoClose(s))));
  return out;
}

/** Ultima valoracion apuntada, de la propia tabla de marcas. */
export async function lastMarkAt(): Promise<number | null> {
  const rows = await db
    .select({ at: poweroMarks.at })
    .from(poweroMarks)
    .orderBy(desc(poweroMarks.at))
    .limit(1)
    .catch(() => [] as Array<{ at: number }>);
  return rows[0]?.at ?? null;
}

/**
 * Ultima vez que el RELOJ corrio el oraculo. Va en ajustes y no en la tabla de
 * ordenes a proposito: un dia sin operaciones tambien cuenta como corrido.
 */
export async function lastProposeAt(): Promise<number | null> {
  const raw = await getSetting(POWERO_KEYS.lastProposeAt).catch(() => null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type PoweroState = {
  settings: PoweroSettings;
  marks: Record<Book, BookMark>;
  /**
   * De donde sale el resultado de cada libro y cuanto se le saca al indice.
   * Es lo que convierte "vamos a perdida" en una frase con sujeto.
   */
  attribution: Record<Book, Attribution>;
  orders: Order[];
  /** Propuestas vivas, esperando tu decision. */
  pending: Order[];
  curve: Array<{ at: number; equity: number; book: string }>;
  /**
   * El reloj, en la respuesta. Sin esto no hay forma de distinguir "no hay
   * senales hoy" de "esto esta roto", que es exactamente la duda que provoca
   * un fin de semana sin operaciones.
   */
  clock: {
    lastProposeAt: number | null;
    nextProposeAt: number | null;
    lastMarkAt: number | null;
  };
  asOf: number;
};

const capitalOf = (s: PoweroSettings, book: Book) => (book === "equity" ? s.equityCapital : s.cryptoCapital);

/** Foto completa: libros valorados, registro y curva. */
export async function poweroState(now = Date.now()): Promise<PoweroState> {
  const settings = await resolvePoweroSettings();
  const orders = await listOrders(500);
  const executed = orders.filter((o) => o.status === "executed");
  const symbols = [...new Set(executed.map((o) => o.symbol))];
  const cryptoSymbols = new Set(executed.filter((o) => o.book === "crypto").map((o) => o.symbol));
  const prices = await pricesFor(symbols, cryptoSymbols);

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

  // La ultima linea del indice de cada libro, para poder atribuir contra ella.
  const benchNow = {} as Record<Book, number | null>;
  for (const book of BOOKS) {
    benchNow[book] = curveRows.filter((r) => r.book === benchBook(book)).at(-1)?.equity ?? null;
  }
  const attribution = {} as Record<Book, Attribution>;
  for (const book of BOOKS) attribution[book] = attribute(marks[book], benchNow[book]);

  const proposedAt = await lastProposeAt();
  return {
    settings,
    marks,
    attribution,
    orders,
    pending: orders.filter((o) => o.status === "proposed"),
    curve: curveRows.map((r) => ({ at: r.at, equity: r.equity, book: r.book })),
    clock: {
      lastProposeAt: proposedAt,
      nextProposeAt: proposedAt === null ? null : proposedAt + PROPOSE_MIN_GAP_MS,
      lastMarkAt: curveRows.at(-1)?.at ?? null,
    },
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

  // Bolsa: el PLAN, no el veredicto.
  //
  // Aqui estaba el fallo que tuvo el libro de bolsa dos dias a cero. El
  // veredicto es una opinion — "mantener", "reducir", "sin cobertura" — y solo
  // las palabras "comprar" y "comprar fuerte" producian senal. Con las 25
  // valoraciones repartidas en 8 mantener, 8 reducir y 9 sin cobertura, el
  // resultado era cero, siempre. Mientras tanto el plan del mismo oraculo si
  // decia que hacer, con importe: 2.030 a MSFT, 1.970 a AMZN.
  //
  // Cripto nunca tuvo el problema porque ya leia `plan.crypto.lines`, la
  // instruccion. Por eso lo unico que habia operado era la escalera.
  const planTotal = plan.equity.lines.reduce((sum, l) => sum + l.amount, 0);
  for (const l of plan.equity.lines) {
    const s = signalFromPlanLine({
      symbol: l.symbol,
      amount: l.amount,
      planTotal,
      price: priceOf.get(l.symbol) ?? null,
      reason: l.reason,
    });
    if (s) out.push(s);
  }
  // Y los recortes, que son la otra mitad de la instruccion.
  for (const t of plan.equity.trims) {
    const s = signalFromTrim({
      symbol: t.symbol,
      pctOfPosition: t.pctOfPosition,
      price: priceOf.get(t.symbol) ?? null,
      reason: t.reason,
    });
    if (s) out.push(s);
  }
  // Salidas del veredicto: el plan solo recorta lo que tienes TU, asi que si
  // el libro lleva algo que el motor manda evitar, se suelta igual.
  for (const v of plan.run.results) {
    if (cryptoSymbols.has(v.symbol)) continue;
    const s = signalFromVerdict({
      symbol: v.symbol,
      posture: v.posture,
      price: priceOf.get(v.symbol) ?? null,
      rationale: v.rationale,
    });
    if (s) out.push(s);
  }
  // Cripto: mismo criterio. El multiplicador dice si se compra, el importe del
  // plan dice cuanto y en que proporcion entre monedas.
  const cryptoTotal = plan.crypto.lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  for (const l of plan.crypto.lines) {
    const s = signalFromLadder({
      symbol: l.symbol,
      multiplier: l.multiplier,
      confirmed: l.confirmed,
      amount: l.amount ?? 0,
      planTotal: cryptoTotal,
      price: l.stats?.price ?? null,
      reason: l.reason,
    });
    if (s) out.push(s);
  }
  return out;
}

/**
 * Genera propuestas nuevas. Devuelve las creadas.
 *
 * `stamp` solo lo pone el reloj. Es una distincion que costo un dia entero de
 * confusion: el boton tambien lo ponia, asi que una pulsacion tuya a las 05:03
 * dejaba la corrida automatica de las 22:05 por debajo del tope de 20 h y el
 * oraculo se saltaba su cita. Mirar no puede cancelar la medicion — el boton
 * es una vista previa, la cita diaria es el instrumento.
 *
 * `commit` es la otra mitad de esa misma idea, y la que faltaba. Sin ella el
 * boton no solo miraba: en modo automatico cada pulsacion CREABA y apuntaba las
 * ordenes en el libro. Entre el 12 y el 14 de septiembre eso solto cuatro
 * tramos de la escalera en 48 horas —tres de ellos a golpe de boton— y dejo los
 * dos libros invertidos al 100% con precios separados por un 0,5%. El resultado
 * no medía al oraculo: medía cuantas veces se habia pulsado. Con `commit:
 * false` el boton calcula y enseña; escribir es cosa del reloj.
 */
export async function proposeNow(
  now = Date.now(),
  opts: { stamp?: boolean; commit?: boolean } = {},
): Promise<Order[]> {
  const commit = opts.commit !== false;
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
  if (opts.stamp) await setSetting(POWERO_KEYS.lastProposeAt, String(now)).catch(() => undefined);
  if (created.length === 0) return [];
  // Vista previa: se devuelve lo que haria el oraculo, sin tocar el libro.
  if (!commit) return created;

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
async function markBenchmark(book: Book, capital: number, now: number): Promise<number | null> {
  const symbol = BENCHMARK[book];
  // El indice tampoco tiene por que estar en tu cartera: BTC no lo esta. Vale
  // la misma reserva que usan las posiciones, sin un camino aparte que
  // mantener.
  const prices = await pricesFor([symbol], book === "crypto" ? new Set([symbol]) : new Set()).catch(
    () => ({}) as Record<string, number | null>,
  );
  const price = prices[symbol] ?? null;
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
