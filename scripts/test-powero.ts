/**
 * Tests del libro nocional de PoWERo (puro, sin red ni base).
 * Correr con: npm run test:powero
 */
import {
  buildBook,
  markBook,
  propose,
  signalFromLadder,
  signalFromVerdict,
  minTicket,
  ticketFor,
  MAX_SYMBOL_PCT,
  MAX_TICKET_PCT,
  MIN_TICKET_FLOOR,
  MIN_TICKET_PCT,
  type Order,
  type Signal,
} from "../src/lib/powero";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

let seq = 0;
const makeId = () => `o${++seq}`;

function ord(p: Partial<Order> & { symbol: string; side: Order["side"]; qty: number; price: number }): Order {
  return {
    id: p.id ?? makeId(),
    book: p.book ?? "equity",
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    price: p.price,
    amount: p.amount ?? p.qty * p.price,
    status: p.status ?? "executed",
    reason: p.reason ?? "",
    source: p.source ?? "test",
    proposedAt: p.proposedAt ?? 1,
    decidedAt: p.decidedAt ?? 2,
  };
}

console.log("\n# buildBook: la cartera se deriva del registro, no se guarda");
{
  const orders = [
    ord({ symbol: "AAA", side: "buy", qty: 2, price: 10, decidedAt: 10 }),
    ord({ symbol: "AAA", side: "buy", qty: 2, price: 20, decidedAt: 20 }),
    ord({ symbol: "BBB", side: "buy", qty: 1, price: 25, decidedAt: 30 }),
    // Descartada: no cuenta.
    ord({ symbol: "CCC", side: "buy", qty: 1, price: 40, status: "discarded", decidedAt: 40 }),
  ];
  const b = buildBook("equity", 100, orders);
  eq(b.cash, 15, "efectivo: 100 - 20 - 40 - 25");
  eq(b.positions.length, 2, "dos posiciones (la descartada no entra)");
  const aaa = b.positions.find((p) => p.symbol === "AAA")!;
  eq([aaa.qty, aaa.avgPrice, aaa.cost], [4, 15, 60], "coste medio movil: 4 uds a 15 de media");
}

console.log("\n# buildBook: vender retira coste en proporcion, no el importe");
{
  const orders = [
    ord({ symbol: "AAA", side: "buy", qty: 4, price: 10, decidedAt: 10 }),
    // Vende la mitad al doble: entran 20 de caja, sale la mitad del coste.
    ord({ symbol: "AAA", side: "sell", qty: 2, price: 20, decidedAt: 20 }),
  ];
  const b = buildBook("equity", 100, orders);
  eq(b.cash, 100, "efectivo: 100 - 40 de compra + 40 de venta");
  const aaa = b.positions.find((p) => p.symbol === "AAA")!;
  eq([aaa.qty, aaa.cost], [2, 20], "quedan 2 uds con 20 de coste, no coste negativo");
  // Recuperado todo el efectivo y con 2 uds gratis: el patrimonio lo refleja.
  eq(markBook(b, { AAA: 20 }).equity, 140, "patrimonio 140: la mitad vendida pago la entera");
}

console.log("\n# buildBook: cada libro es independiente");
{
  const orders = [
    ord({ symbol: "AAA", side: "buy", qty: 1, price: 30, book: "equity" }),
    ord({ symbol: "BTC", side: "buy", qty: 0.001, price: 40000, book: "crypto" }),
  ];
  eq(buildBook("equity", 100, orders).cash, 70, "el libro de bolsa no ve la compra de cripto");
  eq(buildBook("crypto", 100, orders).cash, 60, "y al reves");
}

console.log("\n# markBook: valoracion a precios de ahora");
{
  const b = buildBook("equity", 100, [ord({ symbol: "AAA", side: "buy", qty: 4, price: 10 })]);
  const m = markBook(b, { AAA: 15 });
  eq(m.positionsValue, 60, "4 uds a 15");
  eq(m.equity, 120, "60 de efectivo + 60 en cartera");
  eq([m.pnl, m.pnlPct], [20, 20], "+20 sobre 100 inicial");
  eq(m.lines[0].pnlPct, 50, "la linea gana un 50%");

  const sinPrecio = markBook(b, { AAA: null });
  eq(sinPrecio.positionsValue, 40, "sin precio la linea vale su coste, no cero");
}

console.log("\n# ticketFor: tamano por conviccion, con topes");
{
  const base = { equity: 100, cash: 100, alreadyInSymbol: 0 };
  eq(ticketFor({ ...base, strength: 100 }), MAX_TICKET_PCT, "conviccion maxima: el tope por idea");
  eq(ticketFor({ ...base, strength: 50 }), 12.5, "la mitad de conviccion, la mitad de ticket");
  eq(ticketFor({ ...base, strength: 10 }), 0, `por debajo del minimo (${minTicket(100)}) no propone`);
  eq(ticketFor({ ...base, strength: 100, cash: 8 }), 8, "nunca gasta mas efectivo del que hay");
  eq(
    ticketFor({ ...base, strength: 100, alreadyInSymbol: MAX_SYMBOL_PCT - 10 }),
    10,
    "respeta el tope de exposicion por simbolo (solo cabe lo que falta)",
  );
  eq(
    ticketFor({ ...base, strength: 100, alreadyInSymbol: MAX_SYMBOL_PCT - 2 }),
    0,
    "y si lo que cabe no llega al ticket minimo, no propone migajas",
  );
  eq(ticketFor({ ...base, strength: 100, alreadyInSymbol: MAX_SYMBOL_PCT }), 0, "simbolo lleno: no anade");
  eq(ticketFor({ ...base, strength: 100, cash: 0 }), 0, "sin efectivo no hay propuesta");
}

console.log("\n# el tamano del libro lo pones tu: 10, 1.000 o 15.000");
{
  // Todo es porcentaje del libro, asi que la forma de las propuestas es la
  // misma a cualquier escala. Lo unico absoluto es el suelo del ticket.
  eq(minTicket(100), 5, "libro de 100: ticket minimo 5");
  eq(minTicket(1000), 50, "libro de 1.000: ticket minimo 50");
  eq(minTicket(15000), 750, "libro de 15.000: ticket minimo 750");
  eq(minTicket(10), MIN_TICKET_FLOOR, "libro de 10: el suelo, para que siga pudiendo operar");

  for (const capital of [10, 100, 1000, 15000]) {
    const t = ticketFor({ strength: 100, equity: capital, cash: capital, alreadyInSymbol: 0 });
    eq(
      Math.round((t / capital) * 100),
      MAX_TICKET_PCT,
      `con ${capital} de capital, la conviccion maxima sigue siendo el ${MAX_TICKET_PCT}%`,
    );
  }
  truthy(MIN_TICKET_PCT < MAX_TICKET_PCT, "el minimo cabe por debajo del maximo a cualquier escala");
}

console.log("\n# propose: primero vender, luego comprar con lo que entra");
{
  const orders = [ord({ symbol: "VIEJA", side: "buy", qty: 4, price: 10 })];
  const state = buildBook("equity", 50, orders);
  const mark = markBook(state, { VIEJA: 12 });
  // Efectivo 10, posicion 48, patrimonio 58.
  const signals: Signal[] = [
    { book: "equity", symbol: "NUEVA", side: "buy", strength: 100, price: 20, reason: "barata", source: "veredicto" },
    { book: "equity", symbol: "VIEJA", side: "sell", strength: 100, price: 12, reason: "rota", source: "veredicto" },
  ];
  seq = 0;
  const props = propose({ state, mark, signals, now: 100, makeId });
  eq(props.length, 2, "dos propuestas");
  eq(props[0].side, "sell", "la venta va primero");
  eq([props[0].symbol, props[0].qty, props[0].amount], ["VIEJA", 4, 48], "vende la posicion entera");
  eq(props[1].symbol, "NUEVA", "y luego compra");
  truthy(props[1].amount > 10, `la compra usa el efectivo liberado ($${props[1].amount})`);
  eq(props.every((p) => p.status === "proposed"), true, "nacen como propuesta, nadie ejecuta nada");
}

console.log("\n# propose: sin precio no hay propuesta");
{
  const state = buildBook("crypto", 100, []);
  const mark = markBook(state, {});
  const props = propose({
    state,
    mark,
    signals: [{ book: "crypto", symbol: "X", side: "buy", strength: 100, price: null, reason: "", source: "t" }],
    now: 1,
    makeId,
  });
  eq(props.length, 0, "una propuesta sin cantidad no es una instruccion");
}

console.log("\n# propose: no cruza libros");
{
  const state = buildBook("equity", 100, []);
  const mark = markBook(state, {});
  const props = propose({
    state,
    mark,
    signals: [{ book: "crypto", symbol: "BTC", side: "buy", strength: 100, price: 40000, reason: "", source: "t" }],
    now: 1,
    makeId,
  });
  eq(props.length, 0, "una senal de cripto no toca el libro de bolsa");
}

console.log("\n# senales desde el motor");
{
  const compra = signalFromVerdict({
    symbol: "AAA", posture: "buy", score: 70, marginOfSafetyPct: 20, price: 10, rationale: "buena y barata",
  });
  eq([compra?.side, compra?.strength], ["buy", 90], "compra: postura 70 + margen 20");

  const fuerte = signalFromVerdict({
    symbol: "AAA", posture: "strong_buy", score: 85, marginOfSafetyPct: 40, price: 10, rationale: "",
  });
  eq(fuerte?.strength, 100, "no se pasa de 100");

  const cara = signalFromVerdict({
    symbol: "AAA", posture: "buy", score: 70, marginOfSafetyPct: -20, price: 10, rationale: "",
  });
  eq(cara?.strength, 50, "un margen negativo resta fuerza");

  eq(
    signalFromVerdict({ symbol: "AAA", posture: "hold", score: 60, marginOfSafetyPct: 5, price: 10, rationale: "" }),
    null,
    "mantener no genera nada",
  );

  const venta = signalFromVerdict({
    symbol: "AAA", posture: "sell", score: 20, marginOfSafetyPct: null, price: 10, rationale: "rota",
  });
  eq([venta?.side, venta?.strength], ["sell", 100], "vender sale entera");

  // Reducir NO vende en PoWERo: el libro es pequeno y media posicion de $12
  // no se recorta. Se queda fuera hasta que la postura sea de salida.
  eq(
    signalFromVerdict({ symbol: "AAA", posture: "reduce", score: 50, marginOfSafetyPct: -30, price: 10, rationale: "" }),
    null,
    "reducir no genera orden en un libro de 100 dolares",
  );
}

console.log("\n# escalera cripto: el multiplicador es la fuerza");
{
  eq(signalFromLadder({ symbol: "BTC", multiplier: 1.25, confirmed: true, price: 40000, reason: "r" })?.strength, 25, "1,25x -> 25");
  eq(signalFromLadder({ symbol: "BTC", multiplier: 2, confirmed: true, price: 40000, reason: "r" })?.strength, 100, "2x -> 100");
  eq(signalFromLadder({ symbol: "BTC", multiplier: 1.5, confirmed: false, price: 40000, reason: "r" }), null, "tramo sin confirmar no compra");
  eq(signalFromLadder({ symbol: "BTC", multiplier: 1, confirmed: true, price: 40000, reason: "r" }), null, "aporte normal no es senal");
}

console.log("\n# el libro nunca se queda en negativo");
{
  let state = buildBook("equity", 100, []);
  let mark = markBook(state, {});
  const orders: Order[] = [];
  seq = 0;
  // Diez pasadas pidiendo comprar de todo, a ver si en algun momento se pasa.
  for (let i = 0; i < 10; i++) {
    const props = propose({
      state,
      mark,
      signals: [
        { book: "equity", symbol: "AAA", side: "buy", strength: 100, price: 10, reason: "", source: "t" },
        { book: "equity", symbol: "BBB", side: "buy", strength: 100, price: 10, reason: "", source: "t" },
        { book: "equity", symbol: "CCC", side: "buy", strength: 100, price: 10, reason: "", source: "t" },
      ],
      now: 100 + i,
      makeId,
    });
    for (const p of props) orders.push({ ...p, status: "executed", decidedAt: p.proposedAt });
    state = buildBook("equity", 100, orders);
    mark = markBook(state, { AAA: 10, BBB: 10, CCC: 10 });
  }
  truthy(state.cash >= -0.01, `el efectivo nunca se va por debajo de cero (${state.cash})`);
  const maxLinea = Math.max(...mark.lines.map((l) => l.value));
  truthy(
    maxLinea <= (mark.equity * MAX_SYMBOL_PCT) / 100 + 0.5,
    `ningun simbolo pasa del ${MAX_SYMBOL_PCT}% (mayor: $${maxLinea})`,
  );
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
