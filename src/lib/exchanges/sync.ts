import { and, eq, like, notLike } from "drizzle-orm";
import { db } from "@/db";
import { accounts, transactions, type Account } from "@/db/schema";
import { makeAssetResolver } from "@/lib/assets";
import { buildReconciliation, type HeldTx } from "@/lib/holdings";
import { SYNC_BUSY_ERROR, startSyncRun } from "@/lib/sync-run";
import { chunk, id } from "@/lib/utils";
import { cleanError, clientFor, fetchBalances, fetchTrades, isCash } from "./ccxt";

const RECONCILE_PREFIX = "reconcile-";

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
    // Solo buscamos historial de trades de las monedas de inversion, no del
    // efectivo (no tiene sentido un par USDT/USDT).
    const currencies = balances.filter((b) => !b.isCash).map((b) => b.currency);

    // Solo pedimos trades nuevos desde el ultimo sync, con un dia de solape.
    const since = account.lastSyncAt
      ? account.lastSyncAt - 86_400_000
      : undefined;
    const trades = await fetchTrades(ex, currencies, since).catch(() => []);

    const resolveAsset = makeAssetResolver();

    /* ---------- Operaciones, en tandas ---------- */
    const txRows: (typeof transactions.$inferInsert)[] = [];
    for (const t of trades) {
      if (isCash(t.base)) continue;
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
    // Se recalcula desde cero cada sync: borra los ajustes anteriores para no
    // arrastrar un plug viejo que ya no cuadra.
    await db
      .delete(transactions)
      .where(
        and(
          eq(transactions.accountId, account.id),
          like(transactions.externalId, `${RECONCILE_PREFIX}%`),
        ),
      );

    // Trades REALES (sin ajustes), para replicarlos con el mismo tope-en-0 que
    // usa el motor de P&L. Calcular el ajuste con una suma sin tope era el bug
    // que inflaba las cantidades.
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

    // Balance real del exchange = la verdad. El efectivo (USDT, USD...) entra
    // como clase 'cash'; el resto como cripto.
    const targetQty = new Map<string, number>();
    const cashAssetIds = new Set<string>();
    for (const b of balances) {
      const asset = await resolveAsset(b.currency, b.isCash ? "cash" : "crypto");
      targetQty.set(asset.id, b.amount);
      if (b.isCash) cashAssetIds.add(asset.id);
    }

    const plugs = buildReconciliation(realByAsset, targetQty);
    const adjustments: (typeof transactions.$inferInsert)[] = plugs.map((pl) => {
      const cash = cashAssetIds.has(pl.assetId);
      return {
        id: id(),
        accountId: account.id,
        assetId: pl.assetId,
        type: pl.direction,
        quantity: pl.quantity,
        // El efectivo vale 1:1, asi que su ajuste entra a precio 1 (sin P&L).
        // Para cripto el coste de un deposito es desconocido: precio 0 y la
        // posicion se marca "coste estimado".
        price: cash && pl.direction === "transfer_in" ? 1 : 0,
        fee: 0,
        currency: "USD",
        executedAt: Date.now(),
        externalId: `${RECONCILE_PREFIX}${pl.assetId}`,
        source: "sync",
        note: cash
          ? "Saldo en efectivo del exchange."
          : "Ajuste contra el balance real del exchange. Coste de entrada desconocido.",
      };
    });

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
