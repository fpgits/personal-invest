/**
 * Tests del libro nocional de PoWERo (puro, sin red ni base).
 * Correr con: npm run test:powero
 */
import {
  attribute,
  buildBook,
  markBook,
  propose,
  signalFromLadder,
  signalFromPlanLine,
  signalFromTrim,
  signalFromVerdict,
  minTicket,
  ticketFor,
  LADDER_RUNG_PCT,
  LADDER_STEP_PCT,
  MAX_SYMBOL_PCT,
  MAX_TICKET_PCT,
  MIN_TICKET_FLOOR,
  MIN_TICKET_PCT,
  type Order,
  type Signal,
} from "../src/lib/powero";
import { due, MARK_MIN_GAP_MS, PROPOSE_MIN_GAP_MS } from "../src/lib/powero-settings";

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

console.log("\n# senales desde el motor: el PLAN manda en bolsa");
{
  // El fallo que tuvo el libro de bolsa dos dias parado: la cartera entera en
  // "mantener" y "reducir" producia cero senales, porque solo se miraba la
  // palabra del veredicto. El plan del mismo oraculo si decia que comprar.
  eq(
    signalFromVerdict({ symbol: "AAA", posture: "hold", price: 10, rationale: "" }),
    null,
    "mantener no genera nada",
  );
  eq(
    signalFromVerdict({ symbol: "AAA", posture: "buy", price: 10, rationale: "" }),
    null,
    "las compras ya NO salen del veredicto: salen del plan",
  );

  const venta = signalFromVerdict({ symbol: "AAA", posture: "sell", price: 10, rationale: "rota" });
  eq([venta?.side, venta?.strength], ["sell", 100], "vender sale entera");
  const evitar = signalFromVerdict({ symbol: "AAA", posture: "avoid", price: 10, rationale: "" });
  eq(evitar?.side, "sell", "evitar tambien es una salida");

  // Lo que se traslada de una linea del plan es su PESO, no los dolares: el
  // plan reparte tu nomina, el libro reparte su propio capital.
  const msft = signalFromPlanLine({ symbol: "MSFT", amount: 2030, planTotal: 4000, price: 400, reason: "r" });
  const amzn = signalFromPlanLine({ symbol: "AMZN", amount: 1970, planTotal: 4000, price: 200, reason: "r" });
  eq([msft?.side, msft?.strength], ["buy", 51], "2.030 de 4.000 es fuerza 51");
  eq(amzn?.strength, 49, "1.970 de 4.000 es fuerza 49");
  eq(msft?.source, "plan", "la senal dice de donde viene");
  eq(signalFromPlanLine({ symbol: "A", amount: 0, planTotal: 4000, price: 10, reason: "" }), null, "sin importe no hay senal");
  eq(signalFromPlanLine({ symbol: "A", amount: 100, planTotal: 0, price: 10, reason: "" }), null, "sin plan no hay reparto");
  const solo = signalFromPlanLine({ symbol: "A", amount: 500, planTotal: 500, price: 10, reason: "" });
  eq(solo?.strength, 100, "una sola linea se lleva toda la fuerza");

  // Y el recorte es la otra mitad de la instruccion.
  const trim = signalFromTrim({ symbol: "AMZN", pctOfPosition: 40, price: 200, reason: "cara" });
  eq([trim?.side, trim?.strength, trim?.fraction], ["sell", 40, 0.4], "recortar el 40% es una venta parcial");
  eq(signalFromTrim({ symbol: "A", pctOfPosition: 0, price: 10, reason: "" }), null, "un recorte de cero no es nada");
  eq(signalFromTrim({ symbol: "A", pctOfPosition: 150, price: 10, reason: "" })?.fraction, 1, "no se vende mas del 100%");
}

console.log("\n# una venta parcial suelta solo su fraccion");
{
  const orders: Order[] = [
    { id: "1", book: "equity", symbol: "AAA", side: "buy", qty: 10, price: 10, amount: 100,
      status: "executed", reason: "", source: "t", proposedAt: 1, decidedAt: 1 },
  ];
  const state = buildBook("equity", 200, orders);
  const mark = markBook(state, { AAA: 10 });
  let n = 0;
  const props = propose({
    state,
    mark,
    signals: [{ book: "equity", symbol: "AAA", side: "sell", strength: 40, fraction: 0.4, price: 10, reason: "", source: "recorte" }],
    now: 5,
    makeId: () => `p${++n}`,
  });
  eq(props.length, 1, "el recorte propone una venta");
  eq([props[0].qty, props[0].amount], [4, 40], "vende 4 de las 10 acciones");

  const entera = propose({
    state,
    mark,
    signals: [{ book: "equity", symbol: "AAA", side: "sell", strength: 100, price: 10, reason: "", source: "veredicto" }],
    now: 6,
    makeId: () => "q1",
  });
  eq(entera[0].qty, 10, "sin fraccion se sale entera");
}

console.log("\n# escalera cripto: el multiplicador abre la puerta, el importe la dimensiona");
{
  // El plan real: 1.880 a BTC y 1.250 a ETH. Dos monedas con el MISMO 1,25x
  // pero pesos distintos — antes salian dos tickets identicos de 62,50.
  const btc = signalFromLadder({ symbol: "BTC", multiplier: 1.25, confirmed: true, amount: 1880, planTotal: 3130, price: 40000, reason: "r" });
  const eth = signalFromLadder({ symbol: "ETH", multiplier: 1.25, confirmed: true, amount: 1250, planTotal: 3130, price: 2500, reason: "r" });
  eq(btc?.strength, 60, "1.880 de 3.130 es 60");
  eq(eth?.strength, 40, "1.250 de 3.130 es 40");
  truthy((btc?.targetPct ?? 0) > (eth?.targetPct ?? 0), "el mismo multiplicador ya no da el mismo tamano");

  eq(signalFromLadder({ symbol: "BTC", multiplier: 1.5, confirmed: false, amount: 100, planTotal: 100, price: 4e4, reason: "" }), null, "tramo sin confirmar no compra");
  eq(signalFromLadder({ symbol: "BTC", multiplier: 1, confirmed: true, amount: 100, planTotal: 100, price: 4e4, reason: "" }), null, "aporte normal no es senal");
  eq(signalFromLadder({ symbol: "BTC", multiplier: 1.25, confirmed: true, amount: 0, planTotal: 100, price: 4e4, reason: "" }), null, "sin importe no hay senal");
}

console.log("\n# el objetivo del plan se compra por el hueco que falta");
{
  // Libro de 1.000 con 62,50 ya puestos en BTC y un objetivo del 60%.
  eq(ticketFor({ strength: 60, equity: 1000, cash: 937.5, alreadyInSymbol: 62.5, targetPct: 60 }), 537.5, "compra el hueco hasta el 60%, no un ticket fijo");
  eq(ticketFor({ strength: 60, equity: 1000, cash: 100, alreadyInSymbol: 62.5, targetPct: 60 }), 100, "nunca mas efectivo del que hay");
  eq(ticketFor({ strength: 60, equity: 1000, cash: 900, alreadyInSymbol: 600, targetPct: 60 }), 0, "ya en el objetivo: no compra");
  eq(ticketFor({ strength: 60, equity: 1000, cash: 900, alreadyInSymbol: 580, targetPct: 60 }), 0, "el resto hasta el objetivo no llega al ticket minimo");
  // El viejo camino sigue valiendo cuando no hay plan detras.
  eq(ticketFor({ strength: 25, equity: 1000, cash: 1000, alreadyInSymbol: 0 }), 62.5, "sin objetivo, la fuerza sigue mandando");
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

// --- El reloj: topes para que colgarse de varios crons no duplique trabajo ---
{
  const ahora = 1_000_000_000_000;
  truthy(due(null, MARK_MIN_GAP_MS, ahora), "sin marca previa, siempre toca");
  truthy(due(NaN, MARK_MIN_GAP_MS, ahora), "una marca ilegible se trata como inexistente");
  truthy(
    !due(ahora - 10 * 60_000, MARK_MIN_GAP_MS, ahora),
    "no se vuelve a valorar diez minutos despues",
  );
  truthy(
    due(ahora - 60 * 60_000, MARK_MIN_GAP_MS, ahora),
    "una hora despues si se valora otra vez",
  );
  truthy(
    due(ahora - MARK_MIN_GAP_MS, MARK_MIN_GAP_MS, ahora),
    "justo en el tope ya toca (limite inclusivo)",
  );
  // Lo que de verdad importa: las dos pasadas diarias del cron de foto y del
  // cron dedicado no pueden proponer las dos.
  truthy(
    !due(ahora - 8 * 3_600_000, PROPOSE_MIN_GAP_MS, ahora),
    "propuesto hace ocho horas: no se propone otra vez el mismo dia",
  );
  truthy(
    due(ahora - 24 * 3_600_000, PROPOSE_MIN_GAP_MS, ahora),
    "al dia siguiente si se vuelve a proponer",
  );
  truthy(PROPOSE_MIN_GAP_MS > MARK_MIN_GAP_MS, "se valora mas a menudo de lo que se propone");
}

// --- La escalera tiene que ser una escalera ---
//
// Reproduce lo que paso de verdad entre el 12 y el 14 de septiembre: la misma
// senal, la misma condicion verdadera durante dias, y el precio SIN caer.
console.log("\n# la escalera: por tramos y solo si sigue cayendo");
{
  // Primer tramo: no hay posicion, no hay nada que exigir. Entra un cuarto.
  const primero = ticketFor({ strength: 60, equity: 1000, cash: 1000, alreadyInSymbol: 0, targetPct: 60, laddered: true, price: 77_200, avgPrice: null });
  eq(primero, (1000 * 60 * LADDER_RUNG_PCT) / 10000, `el primer tramo es el ${LADDER_RUNG_PCT}% del objetivo (${primero}$ de 600$)`);

  // Segundo tramo al MISMO precio: esto es exactamente lo que ocurrio.
  const plano = ticketFor({ strength: 60, equity: 1000, cash: 850, alreadyInSymbol: 150, targetPct: 60, laddered: true, price: 77_200, avgPrice: 77_200 });
  eq(plano, 0, "sin caida no hay tramo nuevo: el precio no se ha movido");

  // Y lo que hizo el cuarto tramo real: comprar MAS CARO que el coste medio.
  const masCaro = ticketFor({ strength: 60, equity: 1000, cash: 850, alreadyInSymbol: 150, targetPct: 60, laddered: true, price: 77_630, avgPrice: 77_229 });
  eq(masCaro, 0, "y por encima del coste medio, menos todavia (era el caso real del 14/09)");

  // Con la caida exigida, si.
  const caido = 77_200 * (1 - LADDER_STEP_PCT / 100);
  const segundo = ticketFor({ strength: 60, equity: 1000, cash: 850, alreadyInSymbol: 150, targetPct: 60, laddered: true, price: caido, avgPrice: 77_200 });
  truthy(segundo > 0, `a un ${LADDER_STEP_PCT}% por debajo del coste medio si entra (${segundo}$)`);

  // El ultimo tramo se lleva el resto y no deja astilla.
  const ultimo = ticketFor({ strength: 60, equity: 1000, cash: 500, alreadyInSymbol: 460, targetPct: 60, laddered: true, price: 60_000, avgPrice: 70_000 });
  eq(ultimo, 140, "el ultimo tramo cierra el objetivo entero, sin dejar un resto que ya no entraria");

  // Y el plan de bolsa NO es una escalera: ahi el hueco entero es la instruccion.
  const bolsa = ticketFor({ strength: 70, equity: 1000, cash: 1000, alreadyInSymbol: 0, targetPct: 50 });
  eq(bolsa, 500, "el plan de bolsa sigue comprando el hueco entero: es un reparto objetivo, no una escalera");
}

console.log("\n# cuatro pasadas seguidas no llenan la posicion");
{
  // La prueba que importa: repetir la senal, con el precio quieto, no puede
  // gastar el libro. Antes gastaba los 1.000 en cuatro pulsaciones.
  let orders: Order[] = [];
  let state = buildBook("crypto", 1000, orders);
  seq = 0;
  for (let i = 0; i < 6; i++) {
    const mark = markBook(state, { BTC: 77_200 });
    const props = propose({
      state,
      mark,
      signals: [
        {
          book: "crypto", symbol: "BTC", side: "buy", strength: 60, targetPct: 60, laddered: true,
          price: 77_200, reason: "", source: "escalera",
        },
      ],
      now: 1000 + i,
      makeId,
    });
    orders = [...orders, ...props.map((p) => ({ ...p, status: "executed" as const, decidedAt: p.proposedAt }))];
    state = buildBook("crypto", 1000, orders);
  }
  eq(orders.length, 1, "seis pasadas al mismo precio producen UN tramo, no seis");
  truthy(state.cash > 800, `y el libro conserva munición (${state.cash}$ de 1.000$)`);
}

// --- Atribucion: de donde sale el resultado ---
console.log("\n# la atribucion separa el mercado del oraculo");
{
  // Los numeros reales del libro de bolsa el 15/09/2026.
  const orders: Order[] = [
    ord({ symbol: "MSFT", side: "buy", qty: 1.023949, price: 495.63, amount: 507.5, status: "executed" }),
    ord({ symbol: "AMZN", side: "buy", qty: 1.917984, price: 256.78, amount: 492.5, status: "executed" }),
  ];
  const mark = markBook(buildBook("equity", 1000, orders), { MSFT: 496.54, AMZN: 247.83 });
  const a = attribute(mark, 990.55);

  eq(a.pnlPct, -1.62, "el libro pierde un 1,62%");
  eq(a.benchPct, -0.95, "y el indice un 0,95%");
  eq(a.gapPct, -0.67, "asi que el oraculo va 0,67 puntos POR DEBAJO de no hacer nada");
  eq(a.lines[0].symbol, "AMZN", "lo que mas duele, primero");
  eq(a.lines[0].contributionPct, -1.72, "AMZN se lleva 1,72 puntos del libro");
  truthy(a.lines[1].contributionPct > 0, "y MSFT aporta en positivo");
  // La suma tiene que cuadrar con el resultado: si no, la tabla miente.
  const suma = a.lines.reduce((s, l) => s + l.contributionPct, 0);
  truthy(Math.abs(suma - a.pnlPct) < 0.02, `las aportaciones suman el resultado (${suma.toFixed(2)} vs ${a.pnlPct})`);

  // Sin linea de indice todavia, la atribucion no inventa una diferencia.
  eq(attribute(mark, null).gapPct, null, "sin indice no hay diferencia que contar");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
