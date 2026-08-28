import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  syncRuns,
  transactions,
  type Account,
} from "@/db/schema";
import { ensureAsset } from "@/lib/assets";
import { id } from "@/lib/utils";
import {
  cleanError,
  clientFor,
  fetchBalances,
  fetchTrades,
  isFiat,
} from "./ccxt";

export type SyncResult = {
  accountId: string;
  ok: boolean;
  importedTrades: number;
  reconciled: number;
  error?: string;
};

/**
 * Sincroniza una cuenta de exchange.
 *
 * 1. Lee el balance real (fuente de verdad de cuanto tienes).
 * 2. Importa el historial de trades que el exchange deje leer.
 * 3. Ajusta diferencias con transferencias de coste desconocido, en vez de
 *    inventarse un precio de entrada que falsearia el P&L.
 */
export async function syncAccount(account: Account): Promise<SyncResult> {
  const runId = id();
  await db.insert(syncRuns).values({
    id: runId,
    accountId: account.id,
    startedAt: Date.now(),
    status: "running",
  });

  const finish = async (patch: Partial<typeof syncRuns.$inferInsert>) => {
    await db
      .update(syncRuns)
      .set({ finishedAt: Date.now(), ...patch })
      .where(eq(syncRuns.id, runId));
  };

  try {
    const ex = await clientFor(account);
    const balances = await fetchBalances(ex);
    const currencies = balances.map((b) => b.currency);

    // Solo pedimos trades nuevos desde el ultimo sync, con un dia de solape.
    const since = account.lastSyncAt
      ? account.lastSyncAt - 86_400_000
      : undefined;
    const trades = await fetchTrades(ex, currencies, since).catch(() => []);

    let importedTrades = 0;
    for (const t of trades) {
      if (isFiat(t.base)) continue;
      const asset = await ensureAsset({
        symbol: t.base,
        assetClass: "crypto",
      });

      const inserted = await db
        .insert(transactions)
        .values({
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
        })
        .onConflictDoNothing()
        .returning({ id: transactions.id });

      if (inserted.length > 0) importedTrades++;
    }

    // Reconciliacion: lo que dice el exchange manda.
    let reconciled = 0;
    for (const b of balances) {
      const asset = await ensureAsset({
        symbol: b.currency,
        assetClass: "crypto",
      });

      const [agg] = await db
        .select({
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
        .where(
          and(
            eq(transactions.accountId, account.id),
            eq(transactions.assetId, asset.id),
          ),
        );

      const known = Number(agg?.net ?? 0);
      const diff = b.amount - known;
      if (Math.abs(diff) < 1e-8) continue;

      await db.insert(transactions).values({
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
      reconciled++;
    }

    await db
      .update(accounts)
      .set({ lastSyncAt: Date.now(), status: "active", lastError: null })
      .where(eq(accounts.id, account.id));

    await finish({ status: "ok", imported: importedTrades });

    return { accountId: account.id, ok: true, importedTrades, reconciled };
  } catch (e) {
    const error = cleanError(e);
    await db
      .update(accounts)
      .set({ status: "error", lastError: error })
      .where(eq(accounts.id, account.id));
    await finish({ status: "error", error });
    return {
      accountId: account.id,
      ok: false,
      importedTrades: 0,
      reconciled: 0,
      error,
    };
  }
}

export async function syncAllAccounts(): Promise<SyncResult[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.type, "exchange"), eq(accounts.status, "active")));

  const out: SyncResult[] = [];
  for (const acc of rows) {
    out.push(await syncAccount(acc));
  }
  return out;
}
