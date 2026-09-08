import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { accounts, cashFlows, type CashFlow } from "@/db/schema";
import type { FlexCash } from "./brokers/ibkr";
import type { ExchangeTransfer } from "./exchanges/ccxt";
import { chunk, id } from "./utils";

/**
 * Historial de efectivo inyectado (y retirado) por cuenta. Vive aparte de
 * `transactions`: los plugs de reconciliacion de ahi solo reflejan el saldo
 * ACTUAL y se reescriben en cada sync, asi que no sirven de historial. Aqui
 * cada fila es un aporte o retiro real, con su fecha e importe verdaderos.
 *
 * De esto sale el "capital neto aportado" = depositos - retiros, que es justo
 * lo que NO debe contar como ganancia: el retorno real es valor actual menos
 * lo aportado.
 */

export type CashFlowKind = "deposit" | "withdrawal";

/** Lo que se va a guardar; el id se genera al insertar. */
export type CashFlowInput = {
  accountId: string;
  kind: CashFlowKind;
  /** Magnitud positiva en `currency`. */
  amount: number;
  currency: string;
  occurredAt: number;
  /** id estable de la fuente, para no duplicar al reimportar. */
  externalId: string;
  source: string;
  note?: string | null;
};

// ---------------------------------------------------------------------------
// Extraccion desde las fuentes (puro y testeable)

/**
 * IBKR: de la seccion Cash Transactions nos quedamos con los movimientos de
 * tipo Deposits/Withdrawals. El signo del importe da el sentido: positivo es
 * aporte, negativo retiro.
 */
export function isCashTransfer(c: FlexCash): boolean {
  return /deposit|withdrawal/i.test(c.type) && c.amount !== 0;
}

/**
 * Que tipos de movimiento trajo el informe y cuales quedaron fuera. El filtro
 * de arriba es una lista blanca sobre un texto libre de IBKR: si algun dia
 * etiquetan un traspaso de otra forma, se descartaria EN SILENCIO y el capital
 * aportado saldria mal sin que nada avisara. Esto lo deja en el log de la
 * sincronizacion, que es donde se puede mirar. Puro.
 */
export function cashTypeBreakdown(cash: FlexCash[]): { kept: string[]; dropped: string[] } {
  const kept = new Set<string>();
  const dropped = new Set<string>();
  for (const c of cash) {
    const label = c.type || "(sin tipo)";
    if (isCashTransfer(c)) kept.add(label);
    else dropped.add(label);
  }
  return { kept: [...kept].sort(), dropped: [...dropped].sort() };
}

export function flexCashFlows(cash: FlexCash[], accountId: string): CashFlowInput[] {
  const out: CashFlowInput[] = [];
  for (const c of cash) {
    if (!isCashTransfer(c)) continue;
    out.push({
      accountId,
      kind: c.amount >= 0 ? "deposit" : "withdrawal",
      amount: Math.abs(c.amount),
      currency: (c.currency || "USD").toUpperCase(),
      occurredAt: c.executedAt,
      // transactionID de IBKR: estable entre informes.
      externalId: `ibkr:${c.transactionId}`,
      source: "ibkr",
      note: c.description?.slice(0, 200) || null,
    });
  }
  return out;
}

/**
 * Exchange: los movimientos de efectivo (fiat y stablecoins) que ya vienen
 * filtrados y normalizados por `fetchCashTransfers`. No incluye transferencias
 * de cripto de inversion: mover monedas no es "cash inyectado".
 */
export function exchangeCashFlows(
  transfers: ExchangeTransfer[],
  accountId: string,
  source: string,
): CashFlowInput[] {
  return transfers
    .filter((t) => t.amount > 0)
    .map((t) => ({
      accountId,
      kind: t.kind,
      amount: Math.abs(t.amount),
      currency: (t.currency || "USD").toUpperCase(),
      occurredAt: t.occurredAt,
      externalId: `${source}:${t.id}`,
      source,
      note: t.note ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Agregacion (puro)

export type CashFlowRowLike = {
  accountId: string;
  kind: string;
  amount: number;
};

export type AccountContribution = {
  accountId: string;
  deposits: number;
  withdrawals: number;
  /** depositos - retiros. */
  net: number;
  count: number;
};

export type ContributionSummary = {
  deposits: number;
  withdrawals: number;
  net: number;
  byAccount: AccountContribution[];
};

/** Suma aportes/retiros en total y por cuenta. Magnitudes siempre positivas. */
export function summarizeContributions(rows: CashFlowRowLike[]): ContributionSummary {
  let deposits = 0;
  let withdrawals = 0;
  const by = new Map<string, AccountContribution>();
  for (const r of rows) {
    const amt = Math.abs(r.amount);
    const isDep = r.kind === "deposit";
    if (isDep) deposits += amt;
    else withdrawals += amt;
    const a =
      by.get(r.accountId) ??
      { accountId: r.accountId, deposits: 0, withdrawals: 0, net: 0, count: 0 };
    if (isDep) a.deposits += amt;
    else a.withdrawals += amt;
    a.net = a.deposits - a.withdrawals;
    a.count++;
    by.set(r.accountId, a);
  }
  return {
    deposits,
    withdrawals,
    net: deposits - withdrawals,
    byAccount: [...by.values()].sort((x, y) => y.net - x.net),
  };
}

/**
 * Retorno sobre lo aportado: valor actual menos el capital neto que metiste.
 * Es la ganancia total honesta (realizado + no realizado + dividendos, neto de
 * retiros). El % es sobre lo aportado; sin aportes registrados no hay %.
 */
export function returnOnContributions(
  currentValue: number,
  net: number,
): { gain: number; gainPct: number | null } {
  const gain = currentValue - net;
  return { gain, gainPct: net > 0 ? (gain / net) * 100 : null };
}

/** Dias que IBKR puede tardar en reflejar una transferencia en el Flex. */
export const CASH_REPORT_LAG_DAYS = 5;

export type CashFreshness = {
  /** Fecha del ultimo movimiento importado, o null si no hay ninguno. */
  lastAt: number | null;
  daysSince: number | null;
  /**
   * true cuando un aporte hecho hace poco todavia podria no haber llegado.
   * Las operaciones aparecen en el Flex el mismo dia, pero las transferencias
   * de efectivo tardan en asentarse: sin decirlo, un aporte reciente que no
   * sale parece un fallo de la app cuando es el broker el que aun no lo tiene.
   */
  couldBePending: boolean;
};

/** Frescura del historial de efectivo. Puro. */
export function cashFreshness(
  rows: Array<{ occurredAt: number }>,
  now: number = Date.now(),
): CashFreshness {
  if (rows.length === 0) return { lastAt: null, daysSince: null, couldBePending: true };
  const lastAt = rows.reduce((max, r) => (r.occurredAt > max ? r.occurredAt : max), 0);
  const daysSince = Math.max(0, Math.floor((now - lastAt) / 86400_000));
  return { lastAt, daysSince, couldBePending: daysSince >= CASH_REPORT_LAG_DAYS };
}

// ---------------------------------------------------------------------------
// Base de datos

export async function upsertCashFlows(inputs: CashFlowInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  let n = 0;
  for (const part of chunk(inputs, 50)) {
    const inserted = await db
      .insert(cashFlows)
      .values(part.map((i) => ({ id: id(), ...i, note: i.note ?? null })))
      // Clave unica (accountId, externalId): reimportar periodos solapados no duplica.
      .onConflictDoNothing()
      .returning({ id: cashFlows.id });
    n += inserted.length;
  }
  return n;
}

export type CashFlowView = CashFlow & { accountName: string; accountType: string };

/**
 * Todos los movimientos (o los de una ventana), con el nombre y el tipo de la
 * cuenta (el tipo sirve para dividir por grupo: exchange → cripto, broker →
 * bolsa).
 */
export async function listCashFlows(
  window: { fromMs?: number; toMs?: number } = {},
): Promise<CashFlowView[]> {
  const conds = [];
  if (window.fromMs !== undefined) conds.push(gte(cashFlows.occurredAt, window.fromMs));
  if (window.toMs !== undefined) conds.push(lte(cashFlows.occurredAt, window.toMs));
  const rows = await db
    .select({ cf: cashFlows, accountName: accounts.name, accountType: accounts.type })
    .from(cashFlows)
    .innerJoin(accounts, eq(cashFlows.accountId, accounts.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(cashFlows.occurredAt));
  return rows.map((r) => ({ ...r.cf, accountName: r.accountName, accountType: r.accountType }));
}
