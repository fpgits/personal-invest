/**
 * Tests del historial de aportes de capital (puro, sin red ni base de datos):
 * extraccion de depositos/retiros desde IBKR (FlexCash) y desde exchanges,
 * agregacion del capital neto aportado y retorno sobre lo aportado.
 * Correr con: npm run test:ai  →  incluido en npm test como test:cashflows
 */
import {
  exchangeCashFlows,
  flexCashFlows,
  isCashTransfer,
  returnOnContributions,
  summarizeContributions,
  type CashFlowRowLike,
} from "../src/lib/cashflows";
import type { FlexCash } from "../src/lib/brokers/ibkr";
import type { ExchangeTransfer } from "../src/lib/exchanges/ccxt";

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

function near(actual: number, expected: number, label: string, tol = 1e-9) {
  checks++;
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${expected}, obtenido ${actual}`);
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

const cash = (over: Partial<FlexCash>): FlexCash => ({
  transactionId: "T1",
  symbol: null,
  type: "Deposits/Withdrawals",
  amount: 1000,
  currency: "USD",
  executedAt: Date.UTC(2026, 1, 10),
  description: "CASH RECEIPT",
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n# IBKR: clasificacion de movimientos de efectivo");
{
  truthy(isCashTransfer(cash({})), "Deposits/Withdrawals es aporte/retiro");
  truthy(isCashTransfer(cash({ type: "Deposits/Withdrawals", amount: -500 })), "un retiro tambien");
  truthy(!isCashTransfer(cash({ type: "Dividends" })), "un dividendo NO");
  truthy(!isCashTransfer(cash({ type: "Withholding Tax", amount: -3 })), "una retencion NO");
  truthy(!isCashTransfer(cash({ type: "Broker Interest Received" })), "intereses NO");
  truthy(!isCashTransfer(cash({ amount: 0 })), "importe 0 NO");
}

// ---------------------------------------------------------------------------
console.log("\n# IBKR: extraccion a cash_flows");
{
  const flows = flexCashFlows(
    [
      cash({ transactionId: "A", amount: 5000, executedAt: Date.UTC(2026, 0, 5) }),
      cash({ transactionId: "B", type: "Dividends", amount: 12 }), // se ignora
      cash({ transactionId: "C", type: "Deposits/Withdrawals", amount: -2000, currency: "usd" }),
    ],
    "acc-ibkr",
  );
  eq(flows.length, 2, "solo entran los depositos/retiros");
  eq(flows[0], {
    accountId: "acc-ibkr",
    kind: "deposit",
    amount: 5000,
    currency: "USD",
    occurredAt: Date.UTC(2026, 0, 5),
    externalId: "ibkr:A",
    source: "ibkr",
    note: "CASH RECEIPT",
  }, "aporte con externalId estable y currency en mayuscula");
  eq(flows[1].kind, "withdrawal", "importe negativo → retiro");
  eq(flows[1].amount, 2000, "magnitud positiva");
  eq(flows[1].currency, "USD", "currency normalizada");
}

// ---------------------------------------------------------------------------
console.log("\n# Exchange: extraccion a cash_flows");
{
  const transfers: ExchangeTransfer[] = [
    { id: "deposit:d1", kind: "deposit", amount: 300, currency: "USDT", occurredAt: 111, note: null },
    { id: "withdrawal:w1", kind: "withdrawal", amount: 50, currency: "usdt", occurredAt: 222, note: null },
    { id: "deposit:d0", kind: "deposit", amount: 0, currency: "USDT", occurredAt: 333, note: null }, // se filtra
  ];
  const flows = exchangeCashFlows(transfers, "acc-bin", "binance");
  eq(flows.length, 2, "los de importe 0 se filtran");
  eq(flows[0].externalId, "binance:deposit:d1", "externalId con prefijo de fuente");
  eq(flows[0].source, "binance", "fuente");
  eq(flows[1].currency, "USDT", "currency en mayuscula");
  eq(flows[1].kind, "withdrawal", "sentido preservado");
}

// ---------------------------------------------------------------------------
console.log("\n# Agregacion: capital neto aportado");
{
  const rows: CashFlowRowLike[] = [
    { accountId: "ibkr", kind: "deposit", amount: 10000 },
    { accountId: "ibkr", kind: "deposit", amount: 5000 },
    { accountId: "ibkr", kind: "withdrawal", amount: 2000 },
    { accountId: "bin", kind: "deposit", amount: 1000 },
  ];
  const s = summarizeContributions(rows);
  eq(s.deposits, 16000, "total aportado");
  eq(s.withdrawals, 2000, "total retirado");
  eq(s.net, 14000, "neto = aportes - retiros");
  eq(s.byAccount.map((a) => a.accountId), ["ibkr", "bin"], "ordenado por neto desc");
  eq(s.byAccount[0], { accountId: "ibkr", deposits: 15000, withdrawals: 2000, net: 13000, count: 3 }, "desglose IBKR");
  eq(s.byAccount[1].net, 1000, "desglose Binance");
  eq(summarizeContributions([]), { deposits: 0, withdrawals: 0, net: 0, byAccount: [] }, "sin filas: ceros");
}

// ---------------------------------------------------------------------------
console.log("\n# Retorno sobre lo aportado");
{
  const a = returnOnContributions(20000, 14000);
  near(a.gain, 6000, "ganancia = valor - neto aportado");
  near(a.gainPct ?? -1, (6000 / 14000) * 100, "% sobre lo aportado");

  const loss = returnOnContributions(12000, 14000);
  near(loss.gain, -2000, "puede ser negativo");

  const noneNet = returnOnContributions(500, 0);
  eq(noneNet.gainPct, null, "sin aportes no hay %");
  near(noneNet.gain, 500, "pero la ganancia absoluta se calcula igual");

  const withdrawnAll = returnOnContributions(500, -100);
  eq(withdrawnAll.gainPct, null, "neto negativo tampoco da %");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
