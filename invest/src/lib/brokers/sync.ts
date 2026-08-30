import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, transactions, type Account } from "@/db/schema";
import { makeAssetResolver } from "@/lib/assets";
import { decrypt } from "@/lib/crypto";
import { SYNC_BUSY_ERROR, startSyncRun } from "@/lib/sync-run";
import { chunk, id } from "@/lib/utils";
import { fetchStatement, isDividend, mapAssetClass } from "./ibkr";

export type BrokerSyncResult = {
  accountId: string;
  ok: boolean;
  importedTrades: number;
  importedDividends: number;
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

    /* ---------- Reconciliacion contra Open Positions ---------- */
    // Una sola query agregada por cuenta, en vez de una por posicion.
    const knownRows = await db
      .select({
        assetId: transactions.assetId,
        net: sql<number>`
          coalesce(sum(
            case
              when ${transactions.type} in ('buy','transfer_in') then ${transactions.quantity}
              when ${transactions.type} in ('sell','transfer_out') then -${transactions.quantity}
              else 0
            end
          ), 0)
        `,
      })
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .groupBy(transactions.assetId);

    const known = new Map(knownRows.map((r) => [r.assetId, Number(r.net)]));

    const adjustments: (typeof transactions.$inferInsert)[] = [];
    for (const p of statement.positions) {
      const assetClass = mapAssetClass(p.assetCategory);
      if (!assetClass) continue;

      const asset = await resolveAsset(p.symbol, assetClass);
      const diff = p.quantity - (known.get(asset.id) ?? 0);
      if (Math.abs(diff) < 1e-6) continue;

      // A diferencia de un exchange, IBKR si nos da el coste medio, asi que
      // el ajuste entra con su coste real en vez de con coste desconocido.
      adjustments.push({
        id: id(),
        accountId: account.id,
        assetId: asset.id,
        type: diff > 0 ? "transfer_in" : "transfer_out",
        quantity: Math.abs(diff),
        price: diff > 0 ? p.costBasisPrice : 0,
        fee: 0,
        currency: p.currency,
        executedAt: Date.now(),
        externalId: `ibkr-reconcile:${asset.id}:${Date.now()}`,
        source: "sync",
        note: "Ajuste contra Open Positions de IBKR. Pasa cuando la Flex Query no cubre todo el historico de operaciones.",
      });
    }

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
      reconciled: adjustments.length,
      skipped: statement.skipped.length,
      ibkrAccount: statement.accountId,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Error desconocido");
  }
}
