import type { Posture } from "./conviction-labels";

/**
 * PoWERo: el libro nocional.
 *
 * Que es y que NO es. La app lleva meses produciendo veredictos, escalera
 * cripto y apuestas asimetricas, y nadie sabe si aciertan: el marcador nunca
 * se lleno. PoWERo es el marcador con forma de cuenta. Arranca con un capital
 * de mentira ($100 en cripto, $100 en bolsa), toma las senales que el motor ya
 * produce, las dimensiona, las apunta con precio y hora, y las valora a
 * mercado cada pocos minutos. De ahi sale una curva de balance real: la de tus
 * senales, con precios reales, sin arriesgar un dolar.
 *
 * NO coloca ordenes. Ni ahora ni cuando gane autonomia. La autonomia que puede
 * ganarse es proponer sin preguntar y avisarte; apretar el boton en el broker
 * es tuyo, siempre. La app entera es de solo lectura y las claves no tienen
 * permiso de operar.
 *
 * Este modulo es puro: recibe el libro y las senales, devuelve propuestas y
 * valoraciones. No toca la base ni la red, asi que se puede probar entero.
 */

/** Los dos libros van separados: no se mezcla el efectivo de bolsa con el de cripto. */
export type Book = "equity" | "crypto";

export type Side = "buy" | "sell";

/** Estado de una propuesta: nace propuesta y tu decides. */
export type OrderStatus = "proposed" | "executed" | "discarded";

export type Order = {
  id: string;
  book: Book;
  symbol: string;
  side: Side;
  /** Unidades. En cripto puede ser fraccion; en bolsa tambien (IBKR admite). */
  qty: number;
  /** Precio al que se propuso (o al que dijiste que ejecutaste). */
  price: number;
  amount: number;
  status: OrderStatus;
  /** Por que se propuso, en una linea que se pueda leer meses despues. */
  reason: string;
  /** Que la genero: veredicto, escalera, apuesta. */
  source: string;
  proposedAt: number;
  decidedAt: number | null;
};

export type Position = {
  symbol: string;
  book: Book;
  qty: number;
  /** Coste medio por unidad de lo que queda en cartera. */
  avgPrice: number;
  cost: number;
};

export type BookState = {
  book: Book;
  /** Capital inicial nocional. */
  initial: number;
  cash: number;
  positions: Position[];
};

/** Valoracion del libro a precios de ahora. */
export type BookMark = {
  book: Book;
  cash: number;
  positionsValue: number;
  equity: number;
  initial: number;
  pnl: number;
  pnlPct: number;
  lines: Array<Position & { price: number | null; value: number; pnl: number; pnlPct: number }>;
};

// ---------------------------------------------------------------------------
// Cartera nocional a partir del registro

/**
 * Reconstruye posiciones y efectivo desde las ordenes EJECUTADAS, en orden.
 * El libro no se guarda: se deriva. Asi no hay dos versiones de la verdad y
 * cualquier correccion en el registro se refleja sola.
 *
 * Coste medio movil: comprar promedia, vender no cambia el coste unitario (el
 * resultado realizado sale de la diferencia con el precio de venta). Es la
 * convencion mas simple de explicar, y aqui explicarse importa mas que el
 * matiz fiscal. Puro.
 */
export function buildBook(book: Book, initial: number, orders: Order[]): BookState {
  const executed = orders
    .filter((o) => o.book === book && o.status === "executed")
    .sort((a, b) => (a.decidedAt ?? a.proposedAt) - (b.decidedAt ?? b.proposedAt));

  let cash = initial;
  const held = new Map<string, Position>();

  for (const o of executed) {
    const p = held.get(o.symbol) ?? { symbol: o.symbol, book, qty: 0, avgPrice: 0, cost: 0 };
    if (o.side === "buy") {
      const qty = p.qty + o.qty;
      const cost = p.cost + o.amount;
      held.set(o.symbol, { ...p, qty, cost, avgPrice: qty > 0 ? cost / qty : 0 });
      cash -= o.amount;
    } else {
      const qty = Math.max(0, p.qty - o.qty);
      // Al vender se retira coste en proporcion, no el importe de la venta:
      // si no, una venta con ganancia dejaria un coste negativo.
      const cost = p.avgPrice * qty;
      held.set(o.symbol, { ...p, qty, cost });
      cash += o.amount;
    }
  }

  return {
    book,
    initial,
    cash: round2(cash),
    positions: [...held.values()].filter((p) => p.qty > 1e-9),
  };
}

/** Valora el libro con los precios de ahora. Sin precio, la linea vale su coste. */
export function markBook(state: BookState, prices: Record<string, number | null>): BookMark {
  const lines = state.positions.map((p) => {
    const price = prices[p.symbol] ?? null;
    const value = price !== null && price > 0 ? p.qty * price : p.cost;
    const pnl = value - p.cost;
    return {
      ...p,
      price,
      value: round2(value),
      pnl: round2(pnl),
      pnlPct: p.cost > 0 ? round1((pnl / p.cost) * 100) : 0,
    };
  });
  const positionsValue = lines.reduce((s, l) => s + l.value, 0);
  const equity = state.cash + positionsValue;
  const pnl = equity - state.initial;
  return {
    book: state.book,
    cash: round2(state.cash),
    positionsValue: round2(positionsValue),
    equity: round2(equity),
    initial: state.initial,
    pnl: round2(pnl),
    pnlPct: state.initial > 0 ? round1((pnl / state.initial) * 100) : 0,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Propuestas

/** Una senal del motor, ya normalizada, lista para dimensionar. */
export type Signal = {
  book: Book;
  symbol: string;
  side: Side;
  /** 0..100: cuanta conviccion hay detras. Decide el tamano. */
  strength: number;
  price: number | null;
  reason: string;
  source: string;
};

/** Porcentaje del libro que se juega una senal de conviccion maxima. */
export const MAX_TICKET_PCT = 25;
/**
 * Ticket minimo, en % del libro. Relativo a proposito: el capital lo pones tu
 * y puede ser 10 dolares o 15.000, asi que un minimo fijo o seria calderilla
 * en el libro grande o se comeria medio libro en el pequeno. Por debajo de un
 * 5% una posicion no mueve la aguja y solo ensucia el registro.
 */
export const MIN_TICKET_PCT = 5;
/** Suelo absoluto para que un libro diminuto siga pudiendo operar. */
export const MIN_TICKET_FLOOR = 1;
/** Tope de exposicion por simbolo, en % del libro. */
export const MAX_SYMBOL_PCT = 35;

/** El ticket minimo de un libro, en dolares. Puro. */
export function minTicket(equity: number): number {
  return Math.max(MIN_TICKET_FLOOR, round2((equity * MIN_TICKET_PCT) / 100));
}

/**
 * Tamano de una compra: proporcional a la conviccion, con tope por idea y por
 * simbolo, y limitado por el efectivo que queda. Devuelve 0 cuando no toca.
 * Todo en porcentajes del libro, asi que funciona igual con 10 que con 15.000.
 * Puro.
 */
export function ticketFor(args: {
  strength: number;
  equity: number;
  cash: number;
  alreadyInSymbol: number;
}): number {
  const { strength, equity, cash, alreadyInSymbol } = args;
  if (equity <= 0 || cash <= 0) return 0;
  const byStrength = (equity * MAX_TICKET_PCT * Math.max(0, Math.min(100, strength))) / 10000;
  const roomInSymbol = Math.max(0, (equity * MAX_SYMBOL_PCT) / 100 - alreadyInSymbol);
  const amount = Math.min(byStrength, roomInSymbol, cash);
  return amount >= minTicket(equity) ? round2(amount) : 0;
}

/**
 * De senales a propuestas. Las ventas salen enteras (si el motor dice salir,
 * se sale); las compras se dimensionan. No propone comprar algo sin precio:
 * sin precio no hay cantidad, y una propuesta sin cantidad no es una
 * instruccion. Puro y determinista.
 */
export function propose(args: {
  state: BookState;
  mark: BookMark;
  signals: Signal[];
  now: number;
  makeId: () => string;
}): Order[] {
  const { state, mark, signals, now, makeId } = args;
  const valueOf = new Map(mark.lines.map((l) => [l.symbol, l.value]));
  const qtyOf = new Map(state.positions.map((p) => [p.symbol, p.qty]));
  let cash = state.cash;
  const out: Order[] = [];

  // Primero las ventas: liberan efectivo para las compras de la misma pasada.
  const ordered = [...signals].sort((a, b) => (a.side === b.side ? b.strength - a.strength : a.side === "sell" ? -1 : 1));

  for (const s of ordered) {
    if (s.book !== state.book) continue;
    if (!isFin(s.price) || s.price <= 0) continue;

    if (s.side === "sell") {
      const qty = qtyOf.get(s.symbol) ?? 0;
      if (qty <= 1e-9) continue;
      const amount = round2(qty * s.price);
      qtyOf.set(s.symbol, 0);
      valueOf.set(s.symbol, 0);
      cash += amount;
      out.push(order(makeId(), state.book, s, "sell", qty, s.price, amount, now));
      continue;
    }

    const amount = ticketFor({
      strength: s.strength,
      equity: mark.equity,
      cash,
      alreadyInSymbol: valueOf.get(s.symbol) ?? 0,
    });
    if (amount <= 0) continue;
    cash -= amount;
    valueOf.set(s.symbol, (valueOf.get(s.symbol) ?? 0) + amount);
    out.push(order(makeId(), state.book, s, "buy", amount / s.price, s.price, amount, now));
  }
  return out;
}

function order(
  id: string,
  book: Book,
  s: Signal,
  side: Side,
  qty: number,
  price: number,
  amount: number,
  now: number,
): Order {
  return {
    id,
    book,
    symbol: s.symbol,
    side,
    qty: round6(qty),
    price: round4(price),
    amount: round2(amount),
    status: "proposed",
    reason: s.reason,
    source: s.source,
    proposedAt: now,
    decidedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Traduccion de los veredictos del motor a senales

/** Postura -> fuerza de compra. Las de venta salen por otra via. */
const BUY_STRENGTH: Partial<Record<Posture, number>> = { strong_buy: 100, buy: 70 };

/**
 * El veredicto de bolsa como senal. La fuerza mezcla la postura con el margen
 * de seguridad: la misma postura no pesa igual con un 5% de descuento que con
 * un 40%. Puro.
 */
export function signalFromVerdict(v: {
  symbol: string;
  posture: Posture;
  score: number;
  marginOfSafetyPct: number | null;
  price: number | null;
  rationale: string;
}): Signal | null {
  if (v.posture === "sell" || v.posture === "avoid") {
    return {
      book: "equity",
      symbol: v.symbol,
      side: "sell",
      strength: 100,
      price: v.price,
      reason: v.rationale,
      source: "veredicto",
    };
  }
  const base = BUY_STRENGTH[v.posture];
  if (base === undefined) return null;
  const mos = Math.max(-20, Math.min(40, v.marginOfSafetyPct ?? 0));
  const strength = Math.max(0, Math.min(100, base + mos));
  return {
    book: "equity",
    symbol: v.symbol,
    side: "buy",
    strength,
    price: v.price,
    reason: v.rationale,
    source: "veredicto",
  };
}

/**
 * La escalera cripto como senal: el multiplicador del ciclo ES la fuerza. Un
 * tramo retenido (multiplicador 1 sin confirmar) no compra. Puro.
 */
export function signalFromLadder(l: {
  symbol: string;
  multiplier: number;
  confirmed: boolean;
  price: number | null;
  reason: string;
}): Signal | null {
  if (!l.confirmed || l.multiplier <= 1) return null;
  // 1,25x -> 40; 1,5x -> 60; 2x -> 100.
  const strength = Math.max(0, Math.min(100, (l.multiplier - 1) * 100));
  return {
    book: "crypto",
    symbol: l.symbol,
    side: "buy",
    strength,
    price: l.price,
    reason: l.reason,
    source: "escalera",
  };
}

// ---------------------------------------------------------------------------

function isFin(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
