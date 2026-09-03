import { and, eq, like, notLike } from "drizzle-orm";
import { db } from "@/db";
import { accounts, transactions, type Account } from "@/db/schema";
import { makeAssetResolver } from "@/lib/assets";
import { flexCashFlows, upsertCashFlows } from "@/lib/cashflows";
import { decrypt } from "@/lib/crypto";
import { buildReconciliation, type HeldTx } from "@/lib/holdings";
import { SYNC_BUSY_ERROR, startSyncRun } from "@/lib/sync-run";
import { chunk, id } from "@/lib/utils";
import { fetchStatement, isDividend, mapAssetClass } from "./ibkr";

const RECONCILE_PREFIX = "ibkr-reconcile:";

export type BrokerSyncResult = {
  accountId: string;
  ok: boolean;
  importedTrades: number;
  importedDividends: number;
  importedCashFlows: number;
  reconciled: number;
  skipped: number;
  ibkrAccount?: string;
  error?: string;
};

const INSERT_CHUNK = 50;

/**
 * Sincroniza una cuenta de IBKR leyendo su Flex Query.
 *
 * La Flex Query debe tener activadas al menos las secciones Trades y
 * Open Positions. Cash Transactions es opcional pero es lo que trae los
 * dividendos.
 *
 * Igual que en exchanges, las escrituras van en tandas de 50 filas por
 * sentencia para no pagar un round trip a Turso por operacion.
 */
export async function syncBroker(account: Account): Promise<BrokerSyncResult> {
  const failResult = (error: string): BrokerSyncResult => ({
    accountId: account.id,
    ok: false,
    importedTrades: 0,
    importedDividends: 0,
    importedCashFlows: 0,
    reconciled: 0,
    skipped: 0,
    error,
  });

  if (!account.apiKeyEnc || !account.flexQueryId) {
    return failResult("La cuenta no tiene token de Flex o id de query guardados");
  }

  const run = await startSyncRun(account.id);
  if (!run) return failResult(SYNC_BUSY_ERROR);

  const fail = async (error: string): Promise<BrokerSyncResult> => {
    await db
      .update(accounts)
      .set({ status: "error", lastError: error })
      .where(eq(accounts.id, account.id));
    await run.finish({ status: "error", error });
    return failResult(error);
  };

  try {
    const token = decrypt(account.apiKeyEnc);
    const statement = await fetchStatement(token, account.flexQueryId);
    const resolveAsset = makeAssetResolver();

    /* ---------- Operaciones ---------- */
    const tradeRows: (typeof transactions.$inferInsert)[] = [];
    for (const t of statement.trades) {
      const assetClass = mapAssetClass(t.assetCategory);
      if (!assetClass) continue;
      const asset = await resolveAsset(t.symbol, assetClass);
      tradeRows.push({
        id: id(),
        accountId: account.id,
        assetId: asset.id,
        type: t.side,
        quantity: t.quantity,
        price: t.price,
        fee: t.commission,
        currency: t.currency,
        executedAt: t.executedAt,
        // transactionID de IBKR: estable entre informes, asi que reimportar
        // periodos solapados no duplica nada.
        externalId: `ibkr:${t.transactionId}`,
        source: "sync",
      });
    }

    let importedTrades = 0;
    for (const part of chunk(tradeRows, INSERT_CHUNK)) {
      const inserted = await db
        .insert(transactions)
        .values(part)
        .onConflictDoNothing()
        .returning({ id: transactions.id });
      importedTrades += inserted.length;
    }

    /* ---------- Dividendos ---------- */
    const dividendRows: (typeof transactions.$inferInsert)[] = [];
    for (const c of statement.cash) {
      if (!isDividend(c) || !c.symbol) continue;
      const asset = await resolveAsset(c.symbol, "equity");
      dividendRows.push({
        id: id(),
        accountId: account.id,
        assetId: asset.id,
        type: "dividend",
        quantity: 1,
        price: c.amount,
        fee: 0,
        currency: c.currency,
        executedAt: c.executedAt,
        externalId: `ibkr:${c.transactionId}`,
        source: "sync",
        note: c.description.slice(0, 200) || null,
      });
    }

    let importedDividends = 0;
    for (const part of chunk(dividendRows, INSERT_CHUNK)) {
      const inserted = await db
        .insert(transactions)
        .values(part)
        .onConflictDoNothing()
        .returning({ id: transactions.id });
      importedDividends += inserted.length;
    }

    /* ---------- Aportes / retiros de efectivo ---------- */
    // Deposits/Withdrawals de la misma seccion Cash Transactions. Van a la
    // tabla cash_flows (historial de capital), no a transactions: no son
    // operaciones y no deben tocar el P&L. Idempotente por externalId.
    const importedCashFlows = await upsertCashFlows(
      flexCashFlows(statement.cash, account.id),
    ).catch(() => 0);

    /* ---------- Reconciliacion contra Open Positions ---------- */
    // Se recalcula desde cero cada sync: borra ajustes anteriores.
    await db
      .delete(transactions)
      .where(
        and(
          eq(transactions.accountId, account.id),
          like(transactions.externalId, `${RECONCILE_PREFIX}%`),
        ),
      );

    // Trades reales (sin ajustes) para el replay con tope-en-0, igual que el
    // motor de P&L. Los dividendos no cuentan para la cantidad.
    const realTx = await db
      .select({
        assetId: transactions.assetId,
        type: transactions.type,
        quantity: transactions.quantity,
        executedAt: transactions.executedAt,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, account.id),
          notLike(transactions.externalId, `${RECONCILE_PREFIX}%`),
        ),
      );

    const realByAsset = new Map<string, HeldTx[]>();
    for (const r of realTx) {
      const list = realByAsset.get(r.assetId) ?? [];
      list.push({
        type: r.type as HeldTx["type"],
        quantity: r.quantity,
        executedAt: r.executedAt,
      });
      realByAsset.set(r.assetId, list);
    }

    // Open Positions de IBKR = la verdad. Guardamos tambien el coste real de
    // cada posicion para que el ajuste de entrada no sea "coste desconocido".
    const targetQty = new Map<string, number>();
    const costByAsset = new Map<string, { price: number; currency: string }>();
    const cashAssetIds = new Set<string>();
    for (const p of statement.positions) {
      const assetClass = mapAssetClass(p.assetCategory);
      if (!assetClass) continue;
      const asset = await resolveAsset(p.symbol, assetClass);
      targetQty.set(asset.id, p.quantity);
      costByAsset.set(asset.id, { price: p.costBasisPrice, currency: p.currency });
    }

    // Saldo en efectivo de la cuenta (USD, EUR...) como clase 'cash', 1:1.
    // Solo hay datos si la Flex Query incluye la seccion "Cash Report".
    for (const cb of statement.cashBalances) {
      const asset = await resolveAsset(cb.currency, "cash");
      targetQty.set(asset.id, cb.amount);
      cashAssetIds.add(asset.id);
    }

    const plugs = buildReconciliation(realByAsset, targetQty);
    const adjustments: (typeof transactions.$inferInsert)[] = plugs.map((pl) => {
      const cost = costByAsset.get(pl.assetId);
      const cash = cashAssetIds.has(pl.assetId);
      return {
        id: id(),
        accountId: account.id,
        assetId: pl.assetId,
        type: pl.direction,
        quantity: pl.quantity,
        // Efectivo: 1:1. Posiciones: IBKR nos da el coste medio real.
        price:
          pl.direction !== "transfer_in" ? 0 : cash ? 1 : cost?.price ?? 0,
        fee: 0,
        currency: cost?.currency ?? "USD",
        executedAt: Date.now(),
        externalId: `${RECONCILE_PREFIX}${pl.assetId}`,
        source: "sync",
        note: cash
          ? "Saldo en efectivo de IBKR."
          : "Ajuste contra Open Positions de IBKR. Pasa cuando la Flex Query no cubre todo el historico.",
      };
    });

    for (const part of chunk(adjustments, INSERT_CHUNK)) {
      await db.insert(transactions).values(part).onConflictDoNothing();
    }

    await db
      .update(accounts)
      .set({ lastSyncAt: Date.now(), status: "active", lastError: null })
      .where(eq(accounts.id, account.id));

    await run.finish({
      status: "ok",
      imported: importedTrades + importedDividends,
    });

    return {
      accountId: account.id,
      ok: true,
      importedTrades,
      importedDividends,
      importedCashFlows,
      reconciled: adjustments.length,
      skipped: statement.skipped.length,
      ibkrAccount: statement.accountId,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Error desconocido");
  }
}
