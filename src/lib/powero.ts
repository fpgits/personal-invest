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
  /**
   * Solo en ventas: que fraccion de la posicion se suelta (0..1). Sin valor,
   * se sale entera. Existe porque el motor no dice "vende AMZN", dice "vende
   * el 40% de AMZN" — y liquidar un buen negocio que solo esta caro no es lo
   * que pidio.
   */
  fraction?: number;
  /**
   * Solo en compras que vienen del plan: que porcentaje del libro quiere el
   * oraculo en este nombre. Es un OBJETIVO, no un ticket — se compra el hueco
   * que falta para llegar, no la misma cifra una y otra vez.
   */
  targetPct?: number;
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
  targetPct?: number;
}): number {
  const { strength, equity, cash, alreadyInSymbol, targetPct } = args;
  if (equity <= 0 || cash <= 0) return 0;

  // Con objetivo del plan se compra el HUECO que falta para llegar a el.
  //
  // El reparto ya lo decidio el oraculo, y lo decidio con sus propios topes por
  // posicion. Volver a recortarlo aqui con los topes de PoWERo seria medir una
  // version aguada de su decision, que es justo lo que un libro de prueba no
  // debe hacer: si dice 60% BTC, se mide el 60% BTC.
  if (isFin(targetPct) && targetPct > 0) {
    const target = (equity * Math.min(100, targetPct)) / 100;
    const gap = Math.min(Math.max(0, target - alreadyInSymbol), cash);
    return gap >= minTicket(equity) ? round2(gap) : 0;
  }

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
      const held = qtyOf.get(s.symbol) ?? 0;
      if (held <= 1e-9) continue;
      const frac = isFin(s.fraction) && s.fraction > 0 ? Math.min(1, s.fraction) : 1;
      const qty = round6(held * frac);
      if (qty <= 1e-9) continue;
      const amount = round2(qty * s.price);
      qtyOf.set(s.symbol, Math.max(0, held - qty));
      valueOf.set(s.symbol, Math.max(0, (valueOf.get(s.symbol) ?? 0) - amount));
      cash += amount;
      out.push(order(makeId(), state.book, s, "sell", qty, s.price, amount, now));
      continue;
    }

    const amount = ticketFor({
      strength: s.strength,
      equity: mark.equity,
      cash,
      alreadyInSymbol: valueOf.get(s.symbol) ?? 0,
      targetPct: s.targetPct,
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

/**
 * El veredicto como SALIDA. Solo eso.
 *
 * Antes esta funcion tambien fabricaba las compras, y ahi estaba el fallo que
 * dejo el libro de bolsa dos dias sin operar: un veredicto es una opinion
 * ("mantener", "reducir"), y solo las palabras exactas "comprar" o "comprar
 * fuerte" producian senal. Con la cartera entera en "mantener" y "reducir",
 * cero. Las compras salen ahora del PLAN, que es la instruccion con importe.
 *
 * Las salidas si nacen aqui, porque el plan solo recorta lo que tienes TU: si
 * el libro nocional lleva algo que el motor manda evitar, hay que soltarlo
 * aunque en tu cartera no exista. Puro.
 */
export function signalFromVerdict(v: {
  symbol: string;
  posture: Posture;
  price: number | null;
  rationale: string;
}): Signal | null {
  if (v.posture !== "sell" && v.posture !== "avoid") return null;
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

/**
 * Una linea del plan de bolsa como senal de compra.
 *
 * El importe del plan esta en TUS dolares (el efectivo del mes); lo que se
 * traslada al libro es la FORMA del reparto, no la cifra: si el plan pone el
 * 51% en MSFT y el 49% en AMZN, el libro hace lo mismo a su escala, tenga 100
 * o 15.000. Asi PoWERo mide la decision del oraculo y no el tamano de tu
 * nomina. Puro.
 */
export function signalFromPlanLine(l: {
  symbol: string;
  amount: number;
  planTotal: number;
  price: number | null;
  reason: string;
}): Signal | null {
  if (!isFin(l.amount) || l.amount <= 0) return null;
  if (!isFin(l.planTotal) || l.planTotal <= 0) return null;
  const share = Math.min(1, l.amount / l.planTotal);
  return {
    book: "equity",
    symbol: l.symbol,
    side: "buy",
    strength: Math.round(share * 100),
    targetPct: share * 100,
    price: l.price,
    reason: l.reason,
    source: "plan",
  };
}

/**
 * Un recorte del plan como senal de venta parcial. El motor ya calculo que
 * fraccion de la posicion suelta ("el 40% de AMZN"); esa misma fraccion se
 * aplica a lo que tenga el libro. Puro.
 */
export function signalFromTrim(t: {
  symbol: string;
  pctOfPosition: number;
  price: number | null;
  reason: string;
}): Signal | null {
  if (!isFin(t.pctOfPosition)) return null;
  const pct = Math.min(100, t.pctOfPosition);
  if (pct <= 0) return null;
  return {
    book: "equity",
    symbol: t.symbol,
    side: "sell",
    strength: pct,
    fraction: pct / 100,
    price: t.price,
    reason: t.reason,
    source: "recorte",
  };
}

/**
 * La escalera cripto como senal.
 *
 * El multiplicador decide SI se compra (un tramo retenido, o sin confirmar, no
 * compra). El IMPORTE del plan decide CUANTO. Esa distincion costo cuatro
 * ordenes de 62,50: se usaba el multiplicador tambien como tamano, y como BTC
 * y ETH tenian el mismo 1,25x salian dos tickets identicos y minusculos — un
 * 6% del libro cada uno — mientras el plan repartia 1.880 a BTC y 1.250 a ETH,
 * que no es ni la misma proporcion ni el mismo orden de magnitud.
 *
 * Es el mismo fallo que tenia el lado de bolsa: leer del plan el campo
 * equivocado. Puro.
 */
export function signalFromLadder(l: {
  symbol: string;
  multiplier: number;
  confirmed: boolean;
  amount: number;
  planTotal: number;
  price: number | null;
  reason: string;
}): Signal | null {
  if (!l.confirmed || l.multiplier <= 1) return null;
  if (!isFin(l.amount) || l.amount <= 0) return null;
  if (!isFin(l.planTotal) || l.planTotal <= 0) return null;
  const share = Math.min(1, l.amount / l.planTotal);
  return {
    book: "crypto",
    symbol: l.symbol,
    side: "buy",
    strength: Math.round(share * 100),
    targetPct: share * 100,
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
