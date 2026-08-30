import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, transactions, type Account } from "@/db/schema";
import { makeAssetResolver } from "@/lib/assets";
import { SYNC_BUSY_ERROR, startSyncRun } from "@/lib/sync-run";
import { chunk, id } from "@/lib/utils";
import { cleanError, clientFor, fetchBalances, fetchTrades, isFiat } from "./ccxt";

export type SyncResult = {
  accountId: string;
  ok: boolean;
  importedTrades: number;
  reconciled: number;
  error?: string;
};

const INSERT_CHUNK = 50;

/**
 * Sincroniza una cuenta de exchange.
 *
 * 1. Lee el balance real (fuente de verdad de cuanto tienes).
 * 2. Importa el historial de trades que el exchange deje leer.
 * 3. Ajusta diferencias con transferencias de coste desconocido, en vez de
 *    inventarse un precio de entrada que falsearia el P&L.
 *
 * Las escrituras van en tandas de 50 filas por sentencia: con la DB en
 * us-east-1 y la funcion en fra1 cada round trip son ~90ms, y un primer sync
 * de 200 trades pasaba de ~20s a un par de segundos.
 */
export async function syncAccount(account: Account): Promise<SyncResult> {
  const run = await startSyncRun(account.id);
  if (!run) {
    return {
      accountId: account.id,
      ok: false,
      importedTrades: 0,
      reconciled: 0,
      error: SYNC_BUSY_ERROR,
    };
  }

  try {
    const ex = await clientFor(account);
    const balances = await fetchBalances(ex);
    const currencies = balances.map((b) => b.currency);

    // Solo pedimos trades nuevos desde el ultimo sync, con un dia de solape.
    const since = account.lastSyncAt
      ? account.lastSyncAt - 86_400_000
      : undefined;
    const trades = await fetchTrades(ex, currencies, since).catch(() => []);

    const resolveAsset = makeAssetResolver();

    /* ---------- Operaciones, en tandas ---------- */
    const txRows: (typeof transactions.$inferInsert)[] = [];
    for (const t of trades) {
      if (isFiat(t.base)) continue;
      const asset = await resolveAsset(t.base, "crypto");
      txRows.push({
        id: id(),
        accountId: account.id,
        assetId: asset.id,
        type: t.side,
        quantity: t.amount,
        price: t.price,
        fee: t.fee,
        currency: t.quote,
        executedAt: t.timestamp,
        externalId: t.externalId,
        source: "sync",
      });
    }

    let importedTrades = 0;
    for (const part of chunk(txRows, INSERT_CHUNK)) {
      const inserted = await db
        .insert(transactions)
        .values(part)
        .onConflictDoNothing()
        .returning({ id: transactions.id });
      importedTrades += inserted.length;
    }

    /* ---------- Reconciliacion: lo que dice el exchange manda ---------- */
    // Una sola query agregada por cuenta, en vez de una por moneda.
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
    for (const b of balances) {
      const asset = await resolveAsset(b.currency, "crypto");
      const diff = b.amount - (known.get(asset.id) ?? 0);
      if (Math.abs(diff) < 1e-8) continue;

      adjustments.push({
        id: id(),
        accountId: account.id,
        assetId: asset.id,
        type: diff > 0 ? "transfer_in" : "transfer_out",
        quantity: Math.abs(diff),
        // Coste desconocido a proposito: el exchange no nos da el precio de
        // entrada de un deposito. Editalo a mano si lo sabes.
        price: 0,
        fee: 0,
        currency: "USD",
        executedAt: Date.now(),
        externalId: `reconcile-${asset.id}-${Date.now()}`,
        source: "sync",
        note: "Ajuste automatico contra el balance del exchange. Coste de entrada desconocido.",
      });
    }

    for (const part of chunk(adjustments, INSERT_CHUNK)) {
      await db.insert(transactions).values(part).onConflictDoNothing();
    }

    await db
      .update(accounts)
      .set({ lastSyncAt: Date.now(), status: "active", lastError: null })
      .where(eq(accounts.id, account.id));

    await run.finish({ status: "ok", imported: importedTrades });

    return {
      accountId: account.id,
      ok: true,
      importedTrades,
      reconciled: adjustments.length,
    };
  } catch (e) {
    const error = cleanError(e);
    await db
      .update(accounts)
      .set({ status: "error", lastError: error })
      .where(eq(accounts.id, account.id));
    await run.finish({ status: "error", error });
    return {
      accountId: account.id,
      ok: false,
      importedTrades: 0,
      reconciled: 0,
      error,
    };
  }
}
