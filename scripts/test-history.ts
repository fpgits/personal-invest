/**
 * Test de la reconstruccion del historico, sin red:
 *  - CSV de Stooq, serie de CoinGecko, Equity Summary de IBKR (XML)
 *  - reconstruccion dia a dia: cierres con huecos (fin de semana), respaldo
 *    al ultimo precio de operacion, efectivo de IBKR vs actual, ventas y
 *    dividendos, ajustes de cuadre excluidos
 *  - puerta de fiabilidad de la foto nocturna
 *  - integracion con SQLite local: escribe, respeta las fotos en vivo
 *    fiables, pisa las malas, es idempotente
 * Correr con: npm run test:history
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `history-test-${process.pid}.db`);
function wipe() {
  for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* no existia */
    }
  }
}
wipe();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";
process.env.FINNHUB_API_KEY = "";

import { createClient } from "@libsql/client";
import { db } from "../src/db";
import { accounts, assets, snapshots, transactions, type Asset, type Transaction } from "../src/db/schema";
import { parseFlexStatement } from "../src/lib/brokers/ibkr";
import {
  closeOn,
  coingeckoToCloses,
  historySummary,
  rebuildDays,
  rebuildHistory,
  type HistoryDeps,
  type LedgerRow,
} from "../src/lib/history";
import { parseStooqCsv, stooqSymbol } from "../src/lib/market/stooq";
import { isReliableSnapshot } from "../src/lib/period-metrics";
import { isReliableSummary } from "../src/lib/snapshot";
import type { PortfolioSummary } from "../src/lib/portfolio";

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

function near(actual: number | null | undefined, expected: number, label: string, tol = 0.01) {
  checks++;
  if (actual === null || actual === undefined || Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`  FALLO ${label}: esperado ~${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

async function migrate() {
  const client = createClient({ url: `file:${dbFile}` });
  const dir = path.join(__dirname, "..", "drizzle");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.execute(s);
    }
  }
  client.close();
}

const ms = (iso: string, h = 12) => Date.parse(`${iso}T${String(h).padStart(2, "0")}:00:00Z`);

// ---------------------------------------------------------------------------
console.log("1. Fuentes");
eq(stooqSymbol("AAPL"), "aapl.us", "simbolo Stooq");
eq(stooqSymbol("BRK.B"), "brk-b.us", "clase de accion");
const csv = "Date,Open,High,Low,Close,Volume\n2026-08-28,100,101,99,100.5,1000\n2026-08-31,101,102,100,102,900\n2026-09-01,102,103,101,0,0\nbad line\n";
eq(parseStooqCsv(csv), [{ date: "2026-08-28", close: 100.5 }, { date: "2026-08-31", close: 102 }], "CSV: cabecera fuera, cierre 0 fuera, lineas raras fuera");
eq(parseStooqCsv("No data"), [], "sin datos → []");
eq(
  coingeckoToCloses([
    { t: Date.UTC(2026, 7, 31), c: 4000 },
    { t: Date.UTC(2026, 8, 1), c: 4100 },
    { t: Date.UTC(2026, 8, 1, 15, 30), c: 4150 }, // punto "ahora"
  ]),
  [{ date: "2026-08-30", close: 4000 }, { date: "2026-08-31", close: 4100 }, { date: "2026-09-01", close: 4150 }],
  "CoinGecko: el punto de las 00:00 es el cierre del dia anterior",
);
const series = new Map([["2026-08-28", 100], ["2026-08-31", 102]]);
eq(closeOn(series, "2026-08-31"), 102, "cierre del dia");
eq(closeOn(series, "2026-08-30"), 100, "domingo: cierre del viernes");
eq(closeOn(series, "2026-09-20"), null, "fuera del margen → null");
eq(closeOn(undefined, "2026-09-01"), null, "sin serie → null");

const flexXml = `<?xml version="1.0"?>
<FlexQueryResponse queryName="q" type="AF"><FlexStatements count="1">
<FlexStatement accountId="U123" fromDate="20260801" toDate="20260901" period="LastMonth">
<AccountInformation accountId="U123" currency="USD"/>
<EquitySummaryInBase>
<EquitySummaryByReportDateInBase accountId="U123" currency="USD" reportDate="20260829" cash="8000.5" stock="9000" total="17000.5"/>
<EquitySummaryByReportDateInBase accountId="U123" currency="USD" reportDate="20260830" cashLong="8100" cashShort="-100" stockLong="9100" stockShort="0" total="17100"/>
<EquitySummaryByReportDateInBase accountId="U123" currency="USD" reportDate="20260830" cash="8200" stock="9100" total="17300"/>
<EquitySummaryByReportDateInBase accountId="U123" currency="USD" reportDate="bad" cash="1" stock="1" total="2"/>
</EquitySummaryInBase>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
const st = parseFlexStatement(flexXml);
eq(st.equitySummary, [
  { date: "2026-08-29", cash: 8000.5, stock: 9000, total: 17000.5 },
  { date: "2026-08-30", cash: 8200, stock: 9100, total: 17300 },
], "Equity Summary: cash o cashLong+cashShort, fechas repetidas → la ultima, fecha ilegible fuera");
eq(parseFlexStatement(flexXml.replace(/<EquitySummaryInBase>[\s\S]*<\/EquitySummaryInBase>/, "")).equitySummary, [], "sin seccion → []");

async function main() {
  console.log("\n2. Reconstruccion dia a dia");
  const now = ms("2026-09-02");
  const A = (id: string, symbol: string, assetClass: string, providerId: string): Asset =>
    ({ id, symbol, name: symbol, assetClass, currency: "USD", providerId, logoUrl: null, cik: null, createdAt: now }) as Asset;
  const AAPL = A("a-aapl", "AAPL", "equity", "AAPL");
  const ETH = A("a-eth", "ETH", "crypto", "ethereum");
  const USD = A("a-usd", "USD", "cash", "");
  const USDT = A("a-usdt", "USDT", "cash", "");

  let n = 0;
  const tx = (asset: Asset, type: string, quantity: number, price: number, date: string, extra: Partial<Transaction> = {}): LedgerRow => ({
    tx: {
      id: `t${++n}`, accountId: asset.assetClass === "crypto" || asset.symbol === "USDT" ? "acc-bin" : "acc-ibkr", assetId: asset.id,
      type, quantity, price, fee: 1, currency: "USD", executedAt: ms(date), externalId: `x${n}`, source: "sync", note: null, createdAt: now, ...extra,
    } as Transaction,
    asset,
    accountType: asset.assetClass === "crypto" || asset.symbol === "USDT" ? "exchange" : "broker",
  });

  // Lunes 24 ago → martes 1 sept. Compra AAPL el 25, ETH el 26, venta parcial AAPL el 31, dividendo el 1.
  const rows: LedgerRow[] = [
    tx(AAPL, "buy", 10, 100, "2026-08-25"),
    tx(ETH, "buy", 0.1, 40000, "2026-08-26"),
    tx(AAPL, "sell", 4, 120, "2026-08-31"),
    tx(AAPL, "dividend", 1, 5, "2026-09-01"),
    // Ajustes de cuadre de hoy: no cuentan para dias pasados.
    tx(USD, "transfer_in", 5000, 1, "2026-09-02", { externalId: "ibkr-reconcile:a-usd", fee: 0 }),
    tx(USDT, "transfer_in", 300, 1, "2026-09-02", { externalId: "reconcile-a-usdt", fee: 0 }),
    tx(AAPL, "transfer_in", 0.5, 110, "2026-09-02", { externalId: "ibkr-reconcile:a-aapl", fee: 0 }),
  ];
  const closes = new Map<string, Map<string, number>>([
    ["a-aapl", new Map([["2026-08-26", 101], ["2026-08-27", 103], ["2026-08-28", 105], ["2026-08-31", 118], ["2026-09-01", 121]])], // sin cierre el 25 (dia de compra) ni fin de semana
    ["a-eth", new Map([["2026-08-26", 41000], ["2026-08-27", 42000], ["2026-08-28", 43000], ["2026-08-29", 43500], ["2026-08-30", 42500], ["2026-08-31", 44000], ["2026-09-01", 45000]])],
  ]);
  const cashNow = [
    { asset: USD, amount: 5000, group: "equity", broker: true },
    { asset: USDT, amount: 300, group: "crypto", broker: false },
  ];
  const equity = [
    { date: "2026-08-28", cash: 6200, stock: 1050, total: 7250 },
    { date: "2026-08-31", cash: 6680, stock: 708, total: 7388 },
  ];

  const days = await rebuildDays({ rows, method: "average", currency: "USD", from: "2026-08-24", to: "2026-09-01", closes, cashNow, equity });
  const by = new Map(days.map((d) => [d.date, d]));
  eq(days.map((d) => d.date).length, 9, "un dia por fecha");

  const d24 = by.get("2026-08-24")!;
  near(d24.totalValue, 5300, "antes de operar: solo el efectivo actual (5000 + 300)");
  eq(d24.cashSource, "current", "sin Equity Summary ese dia: efectivo actual");
  eq(JSON.parse(d24.breakdown).positions.map((p: { symbol: string }) => p.symbol), ["USD", "USDT"], "sin posiciones, si efectivo");

  const d25 = by.get("2026-08-25")!;
  near(d25.totalValue - 5300, 1000, "dia de compra sin cierre: ultimo precio de operacion (100)");
  eq(d25.unpriced, ["AAPL"], "y queda marcado como sin cierre");
  near(d25.unrealizedPnl, -1, "P&L = -comision");

  const d26 = by.get("2026-08-26")!;
  near(d26.totalValue, 5300 + 10 * 101 + 0.1 * 41000, "con cierres: AAPL 101 y ETH 41000");
  eq(d26.unpriced, [], "todo con cierre");

  const d29 = by.get("2026-08-29")!; // sabado
  near(JSON.parse(d29.breakdown).positions.find((p: { symbol: string }) => p.symbol === "AAPL").price, 105, "sabado: cierre del viernes");
  eq(d29.cashSource, "ibkr", "efectivo del Equity Summary (fila del 28, dentro del margen)");
  near(JSON.parse(d29.breakdown).positions.find((p: { symbol: string }) => p.symbol === "USD").value, 6200, "efectivo de IBKR del 28");
  near(JSON.parse(d29.breakdown).positions.find((p: { symbol: string }) => p.symbol === "USDT").value, 300, "el USDT sigue siendo el actual");

  const d31 = by.get("2026-08-31")!;
  near(d31.realizedPnl, 4 * 120 - 1 - 4 * (1001 / 10), "venta parcial realiza contra el coste medio");
  near(JSON.parse(d31.breakdown).positions.find((p: { symbol: string }) => p.symbol === "AAPL").quantity, 6, "quedan 6 AAPL");
  const cls31 = JSON.parse(d31.breakdown).byClass as Array<{ assetClass: string; value: number; realizedPnl: number }>;
  near(cls31.find((c) => c.assetClass === "equity")!.value, 6 * 118 + 6680, "bolsa = acciones + efectivo de IBKR");
  near(cls31.find((c) => c.assetClass === "equity")!.realizedPnl, d31.realizedPnl, "realizado por lado");
  near(cls31.find((c) => c.assetClass === "crypto")!.value, 0.1 * 44000 + 300, "cripto = ETH + USDT");
  eq(JSON.parse(d31.breakdown).meta.broker.total, 7388, "la cifra del broker queda guardada para contrastar");

  const d01 = by.get("2026-09-01")!;
  eq(JSON.parse(d01.breakdown).positions.some((p: { symbol: string; quantity: number }) => p.symbol === "AAPL" && Math.abs(p.quantity - 6.5) < 1e-9), false, "el ajuste de cuadre de hoy no entra en ayer");
  near(d01.unrealizedPnl, 6 * 121 - 6 * (1001 / 10) + (0.1 * 45000 - 4001), "no realizado del 1 sept");

  console.log("\n3. Puerta de fiabilidad de la foto nocturna");
  const pos = (asset: Asset, quantity: number, price: number, costBasis: number) => ({
    asset, quantity, avgCost: 0, costBasis, price, value: quantity * price, unrealizedPnl: 0, unrealizedPct: 0, realizedPnl: 0, dividends: 0, fees: 0,
    dayChange: 0, dayChangePct: 0, weight: 0, priceStale: false, priceUpdatedAt: null, costEstimated: false, group: asset.assetClass === "cash" ? "equity" : asset.assetClass,
  });
  const summary = (positions: ReturnType<typeof pos>[]): PortfolioSummary =>
    ({ currency: "USD", totalValue: 0, costBasis: 0, unrealizedPnl: 0, unrealizedPct: 0, realizedPnl: 0, dividends: 0, fees: 0, dayChange: 0, dayChangePct: 0, positions, closed: [], byClass: [], degraded: false }) as PortfolioSummary;
  eq(isReliableSummary(summary([])), false, "cartera vacia no se guarda");
  eq(isReliableSummary(summary([pos(AAPL, 10, 0, 1000), pos(USD, 500, 1, 500)])), false, "posicion importante sin precio → no fiable");
  eq(isReliableSummary(summary([pos(AAPL, 10, 105, 1000), pos(A("a-dust", "LDFIL", "crypto", ""), 0.1, 0, 3)])), true, "polvo sin precio no bloquea");
  eq(isReliableSummary(summary([pos(AAPL, 10, 105, 1000), pos(USD, 500, 1, 500)])), true, "todo con precio");

  // ---------------------------------------------------------------------------
  console.log("\n4. Integracion con SQLite local");
  await migrate();
  await db.insert(accounts).values([
    { id: "acc-ibkr", name: "IBKR", type: "broker", exchangeId: "ibkr", status: "active", createdAt: now, apiKeyEnc: null, flexQueryId: "1" },
    { id: "acc-bin", name: "Binance", type: "exchange", exchangeId: "binance", status: "active", createdAt: now },
  ]);
  await db.insert(assets).values([AAPL, ETH, USD, USDT]);
  await db.insert(transactions).values(rows.map((r) => r.tx));
  // Fotos previas: una en vivo mala (precios a 0) el 28, una en vivo buena el 31, una reconstruida vieja el 27.
  await db.insert(snapshots).values([
    {
      id: "s-bad", date: "2026-08-28", totalValue: 5300, costBasis: 10300, unrealizedPnl: -5000, realizedPnl: 0, source: "live", createdAt: now,
      breakdown: JSON.stringify({ byClass: [{ assetClass: "equity", value: 5000, weight: 0, unrealizedPnl: -1000 }], positions: [{ symbol: "AAPL", value: 0, quantity: 10, price: 0, weight: 0 }, { symbol: "ETH", value: 0, quantity: 0.1, price: 0, weight: 0 }, { symbol: "USD", value: 5000, quantity: 5000, price: 1, weight: 0 }] }),
    },
    {
      id: "s-good", date: "2026-08-31", totalValue: 9999, costBasis: 9000, unrealizedPnl: 999, realizedPnl: 0, source: "live", createdAt: now,
      breakdown: JSON.stringify({ byClass: [{ assetClass: "equity", value: 9999, weight: 100, unrealizedPnl: 999, realizedPnl: 0, dividends: 0 }], positions: [{ assetId: "a-aapl", symbol: "AAPL", assetClass: "equity", group: "equity", value: 9999, quantity: 6, price: 118, weight: 100, unrealizedPnl: 999 }] }),
    },
    { id: "s-old", date: "2026-08-27", totalValue: 1, costBasis: 1, unrealizedPnl: 0, realizedPnl: 0, source: "rebuilt", createdAt: now, breakdown: "{}" },
  ]);

  const calls = { equity: [] as string[], crypto: [] as string[], flex: 0 };
  const deps: HistoryDeps = {
    now: () => now,
    equityCloses: async (symbol, from, to) => {
      calls.equity.push(`${symbol}:${from}:${to}`);
      return [...closes.get("a-aapl")!.entries()].map(([date, close]) => ({ date, close }));
    },
    cryptoCloses: async (providerId) => {
      calls.crypto.push(providerId);
      return [...closes.get("a-eth")!.entries()].map(([date, close]) => ({ date, close }));
    },
    brokerEquity: async () => {
      calls.flex++;
      return equity;
    },
  };

  const report = await rebuildHistory(deps);
  eq([report.from, report.to, report.days], ["2026-08-25", "2026-09-01", 8], "del primer dia con operaciones hasta ayer");
  eq([report.written, report.kept], [7, 1], "escribe 7, conserva la foto en vivo buena del 31");
  eq(report.errors, [], "sin errores");
  eq(report.cashSource, "ibkr", "efectivo del broker");
  eq(report.unpriced, { AAPL: 1 }, "AAPL sin cierre solo el dia de la compra");
  eq(calls.equity, ["AAPL:2026-08-15:2026-09-01"], "cierres de bolsa con margen por delante");
  eq(calls.crypto, ["ethereum"], "cierres de cripto por id de CoinGecko");
  eq(calls.flex, 1, "un informe Flex por cuenta de broker");

  const all = await db.select().from(snapshots).orderBy(snapshots.date);
  eq(all.map((s) => `${s.date}:${s.source}`), [
    "2026-08-25:rebuilt", "2026-08-26:rebuilt", "2026-08-27:rebuilt", "2026-08-28:rebuilt", "2026-08-29:rebuilt", "2026-08-30:rebuilt", "2026-08-31:live", "2026-09-01:rebuilt",
  ], "la mala del 28 se pisa, la buena del 31 se conserva, la reconstruida vieja del 27 se rehace");
  near(all.find((s) => s.date === "2026-08-31")!.totalValue, 9999, "la foto en vivo buena queda intacta");
  near(all.find((s) => s.date === "2026-08-28")!.totalValue, 6200 + 10 * 105 + 0.1 * 43000 + 300, "el 28 reconstruido con cierres y efectivo de IBKR");
  eq(all.every((s) => s.source === "live" || isReliableSnapshot(s)), true, "todo lo reconstruido pasa la puerta de fiabilidad");

  const again = await rebuildHistory(deps);
  eq([again.written, again.kept], [7, 1], "segunda pasada: idempotente");
  eq((await db.select().from(snapshots)).length, 8, "sin duplicados");

  const summ = await historySummary();
  eq([summ.total, summ.live, summ.rebuilt, summ.unreliable, summ.first, summ.last, summ.firstReliable], [8, 1, 7, 0, "2026-08-25", "2026-09-01", "2026-08-25"], "resumen del historico");

  // Un fallo de una fuente no tumba la pasada.
  const failing = await rebuildHistory({ ...deps, cryptoCloses: async () => { throw new Error("CoinGecko 429"); } });
  eq(failing.errors, ["ETH: CoinGecko 429"], "el error queda en el informe");
  eq(failing.unpriced.ETH > 0, true, "y ETH se valora con el ultimo precio de operacion");
  // Sin ninguna fuente, no se escribe nada.
  const dead = await rebuildHistory({ ...deps, cryptoCloses: async () => [], equityCloses: async () => [] });
  eq([dead.written, dead.days], [0, 0], "sin cierres de ninguna fuente no se reconstruye");
  eq(dead.errors.at(-1), "Ninguna fuente de cierres respondio: no se reconstruye nada", "y lo dice");
  eq((await db.select().from(snapshots)).length, 8, "sin cambios en la base");


}

main()
  .then(() => {
    console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
    wipe();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("Error inesperado:", e);
    wipe();
    process.exit(1);
  });
