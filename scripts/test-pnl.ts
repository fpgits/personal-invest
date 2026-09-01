/**
 * Test del motor de P&L. Sin red y sin Turso real: los precios se inyectan.
 * Correr con: npm run test:pnl
 */
process.env.TURSO_DATABASE_URL ||= "file:/tmp/pnl-test.db";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";

import { buildSummary } from "../src/lib/portfolio";
import { buildReconciliation, netHeldQuantity } from "../src/lib/holdings";
import type { Asset, Transaction } from "../src/db/schema";

let failures = 0;
let checks = 0;

function near(actual: number, expected: number, label: string, tol = 0.01) {
  checks++;
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label} = ${actual.toFixed(2)}`);
  }
}

function asset(symbol: string, assetClass: "equity" | "crypto"): Asset {
  return {
    id: `${assetClass}:${symbol}`,
    symbol,
    name: symbol,
    assetClass,
    currency: "USD",
    providerId: symbol,
    logoUrl: null,
    createdAt: 0,
  };
}

let seq = 0;
function tx(
  a: Asset,
  type: Transaction["type"],
  quantity: number,
  price: number,
  fee = 0,
  dayOffset = 0,
): { tx: Transaction; asset: Asset } {
  return {
    asset: a,
    tx: {
      id: `tx-${seq++}`,
      accountId: "acc",
      assetId: a.id,
      type,
      quantity,
      price,
      fee,
      currency: "USD",
      executedAt: dayOffset * 86_400_000,
      externalId: null,
      source: "manual",
      note: null,
      createdAt: 0,
    },
  };
}

function quotesFor(map: Record<string, number>) {
  return async () =>
    Object.fromEntries(
      Object.entries(map).map(([id, price]) => [
        id,
        {
          price,
          change: 0,
          changePct: 0,
          currency: "USD",
          updatedAt: Date.now(),
          stale: false,
        },
      ]),
    );
}

async function run() {
  const AAPL = asset("AAPL", "equity");
  const BTC = asset("BTC", "crypto");

  console.log("\n1. Coste medio con dos compras");
  {
    // 10 @ 100 y 10 @ 200  ->  medio 150, coste 3000
    const rows = [tx(AAPL, "buy", 10, 100, 0, 1), tx(AAPL, "buy", 10, 200, 0, 2)];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [AAPL.id]: 250 }));
    const pos = p.positions[0];
    near(pos.quantity, 20, "cantidad");
    near(pos.avgCost, 150, "coste medio");
    near(pos.costBasis, 3000, "coste total");
    near(pos.value, 5000, "valor");
    near(pos.unrealizedPnl, 2000, "P&L no realizado");
    near(pos.unrealizedPct, 66.67, "P&L %");
  }

  console.log("\n2. Venta parcial con coste medio");
  {
    // Vende 10 @ 250 sobre un medio de 150  ->  realizado 1000
    const rows = [
      tx(AAPL, "buy", 10, 100, 0, 1),
      tx(AAPL, "buy", 10, 200, 0, 2),
      tx(AAPL, "sell", 10, 250, 0, 3),
    ];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [AAPL.id]: 250 }));
    const pos = p.positions[0];
    near(pos.realizedPnl, 1000, "P&L realizado");
    near(pos.quantity, 10, "cantidad restante");
    near(pos.costBasis, 1500, "coste restante");
    near(pos.avgCost, 150, "coste medio se mantiene");
  }

  console.log("\n3. La misma venta en FIFO da otro resultado");
  {
    // FIFO consume el lote de 100 primero  ->  realizado 2500 - 1000 = 1500
    const rows = [
      tx(AAPL, "buy", 10, 100, 0, 1),
      tx(AAPL, "buy", 10, 200, 0, 2),
      tx(AAPL, "sell", 10, 250, 0, 3),
    ];
    const p = await buildSummary(rows, "fifo", "USD", quotesFor({ [AAPL.id]: 250 }));
    const pos = p.positions[0];
    near(pos.realizedPnl, 1500, "P&L realizado FIFO");
    near(pos.costBasis, 2000, "coste restante FIFO");
  }

  console.log("\n4. Comisiones");
  {
    // Compra 10 @ 100 + 5 de fee  ->  coste 1005, medio 100.5
    const rows = [tx(AAPL, "buy", 10, 100, 5, 1)];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [AAPL.id]: 100 }));
    const pos = p.positions[0];
    near(pos.costBasis, 1005, "coste con fee");
    near(pos.avgCost, 100.5, "medio con fee");
    near(pos.unrealizedPnl, -5, "P&L refleja el fee");
    near(pos.fees, 5, "fees acumulados");
  }

  console.log("\n5. Cierre total pasa a posiciones cerradas");
  {
    const rows = [tx(AAPL, "buy", 10, 100, 0, 1), tx(AAPL, "sell", 10, 130, 0, 2)];
    const p = await buildSummary(rows, "average", "USD", quotesFor({}));
    checks++;
    if (p.positions.length !== 0) {
      failures++;
      console.error(`  FALLO posiciones abiertas: esperado 0, obtenido ${p.positions.length}`);
    } else console.log("  ok  sin posiciones abiertas");
    near(p.closed[0]?.realizedPnl ?? 0, 300, "P&L realizado del cierre");
    near(p.totalValue, 0, "valor total");
  }

  console.log("\n6. Dividendos no tocan la cantidad");
  {
    const rows = [
      tx(AAPL, "buy", 10, 100, 0, 1),
      tx(AAPL, "dividend", 1, 25, 0, 2),
    ];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [AAPL.id]: 100 }));
    near(p.positions[0].quantity, 10, "cantidad sin cambios");
    near(p.dividends, 25, "dividendos");
    near(p.positions[0].costBasis, 1000, "coste sin cambios");
  }

  console.log("\n7. Transferencia entrante con coste desconocido");
  {
    // Deposito de 1 BTC sin precio: el coste se estima al precio actual, asi
    // el P&L es ~0 (no fingimos que todo el valor es ganancia) y se marca.
    const rows = [tx(BTC, "transfer_in", 1, 0, 0, 1)];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [BTC.id]: 60000 }));
    near(p.positions[0].costBasis, 60000, "coste estimado al precio actual");
    near(p.positions[0].unrealizedPnl, 0, "P&L neutro para coste desconocido");
    checks++;
    if (!p.positions[0].costEstimated) {
      failures++;
      console.error("  FALLO: la posicion deberia marcarse costEstimated");
    } else console.log("  ok  posicion marcada como coste estimado");
  }

  console.log("\n8. Pesos y reparto por clase");
  {
    const rows = [
      tx(AAPL, "buy", 10, 100, 0, 1), // 1000 -> 25%
      tx(BTC, "buy", 1, 3000, 0, 1), // 3000 -> 75%
    ];
    const p = await buildSummary(
      rows,
      "average",
      "USD",
      quotesFor({ [AAPL.id]: 100, [BTC.id]: 3000 }),
    );
    near(p.totalValue, 4000, "valor total");
    const btc = p.positions.find((x) => x.asset.symbol === "BTC")!;
    const aapl = p.positions.find((x) => x.asset.symbol === "AAPL")!;
    near(btc.weight, 75, "peso BTC");
    near(aapl.weight, 25, "peso AAPL");
    near(p.byClass.find((c) => c.assetClass === "crypto")!.weight, 75, "peso clase cripto");
    near(p.byClass.find((c) => c.assetClass === "equity")!.weight, 25, "peso clase bolsa");
  }

  console.log("\n9. No se puede vender mas de lo que hay");
  {
    const rows = [tx(AAPL, "buy", 5, 100, 0, 1), tx(AAPL, "sell", 10, 120, 0, 2)];
    const p = await buildSummary(rows, "average", "USD", quotesFor({}));
    near(p.closed[0]?.realizedPnl ?? 0, 100, "solo realiza las 5 que tenia");
    near(p.totalValue, 0, "sin cantidad negativa");
  }

  console.log("\n10. Posicion mixta: compra con coste + deposito sin coste");
  {
    // 1 BTC comprado @ 100 (coste real) + 1 BTC depositado sin precio.
    // Precio actual 200 -> valor 400. Coste = 100 real + 200 estimado = 300.
    // P&L = 400 - 300 = 100: solo gana la parte cuyo coste conocemos.
    const rows = [
      tx(BTC, "buy", 1, 100, 0, 1),
      tx(BTC, "transfer_in", 1, 0, 0, 2),
    ];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [BTC.id]: 200 }));
    const pos = p.positions[0];
    near(pos.quantity, 2, "cantidad total (conocida + deposito)");
    near(pos.costBasis, 300, "coste real + estimado");
    near(pos.unrealizedPnl, 100, "P&L solo de la parte conocida");
    checks++;
    if (!pos.costEstimated) {
      failures++;
      console.error("  FALLO: la posicion mixta deberia marcarse costEstimated");
    } else console.log("  ok  posicion mixta marcada como coste estimado");
  }

  console.log("\n11. netHeldQuantity: las ventas no bajan de 0");
  {
    // Compra 1, vende 3 (2 venian de un deposito que el historial no ve):
    // el replay con tope da 0, no -2.
    near(
      netHeldQuantity([
        { type: "buy", quantity: 1, executedAt: 1 },
        { type: "sell", quantity: 3, executedAt: 2 },
      ]),
      0,
      "no baja de 0",
    );
  }

  console.log("\n12. El ajuste cuadra la cantidad con el balance real");
  {
    // Historial neto (con tope) = 0; balance real 0.5 -> ajuste +0.5 y el
    // motor debe mostrar 0.5.
    const real: Parameters<typeof netHeldQuantity>[0] = [
      { type: "buy", quantity: 1, executedAt: 1 },
      { type: "sell", quantity: 3, executedAt: 2 },
    ];
    const plugs = buildReconciliation(
      new Map([[BTC.id, real]]),
      new Map([[BTC.id, 0.5]]),
    );
    checks++;
    if (
      plugs.length !== 1 ||
      plugs[0].direction !== "transfer_in" ||
      Math.abs(plugs[0].quantity - 0.5) > 1e-9
    ) {
      failures++;
      console.error(`  FALLO ajuste: ${JSON.stringify(plugs)}`);
    } else console.log("  ok  ajuste = +0.5 transfer_in");

    const rows = [
      tx(BTC, "buy", 1, 100, 0, 1),
      tx(BTC, "sell", 3, 120, 0, 2),
      tx(BTC, "transfer_in", 0.5, 0, 0, 3),
    ];
    const p = await buildSummary(rows, "average", "USD", quotesFor({ [BTC.id]: 200 }));
    near(p.positions[0]?.quantity ?? -1, 0.5, "el motor muestra el balance real");
  }

  console.log("\n13. Patron ETH: neto pequeno + balance menor -> ajuste de salida");
  {
    // Reproduce el bug real: el neto con tope da 0.02 y el balance real es dust.
    // El ajuste debe ser una SALIDA hacia el balance real, no una entrada gigante.
    const real: Parameters<typeof netHeldQuantity>[0] = [
      { type: "buy", quantity: 5, executedAt: 1 },
      { type: "sell", quantity: 4.98, executedAt: 2 },
    ];
    const plugs = buildReconciliation(
      new Map([[BTC.id, real]]),
      new Map([[BTC.id, 0.00006886]]),
    );
    checks++;
    const ok =
      plugs.length === 1 &&
      plugs[0].direction === "transfer_out" &&
      Math.abs(plugs[0].quantity - (0.02 - 0.00006886)) < 1e-6;
    if (!ok) {
      failures++;
      console.error(`  FALLO ETH: ${JSON.stringify(plugs)}`);
    } else console.log("  ok  ajuste es salida hacia el balance real (dust)");
  }

  console.log(
    `\n${failures === 0 ? "TODO OK" : "HAY FALLOS"}: ${checks - failures}/${checks} comprobaciones\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
