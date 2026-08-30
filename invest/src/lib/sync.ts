import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accounts, type Account } from "@/db/schema";
import { syncBroker, type BrokerSyncResult } from "./brokers/sync";
import { decrypt } from "./crypto";
import { testConnection as testExchange } from "./exchanges/ccxt";
import { syncAccount as syncExchange, type SyncResult } from "./exchanges/sync";
import { testConnection as testIbkr } from "./brokers/ibkr";

export type AnySyncResult = SyncResult | BrokerSyncResult;

/** Enruta por tipo de cuenta: exchange va por ccxt, broker por Flex de IBKR. */
export async function syncOne(account: Account): Promise<AnySyncResult> {
  if (account.type === "broker") return syncBroker(account);
  if (account.type === "exchange") return syncExchange(account);
  throw new Error(
    `Las cuentas de tipo "${account.type}" no se sincronizan por API`,
  );
}

export async function syncAll(): Promise<AnySyncResult[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(inArray(accounts.type, ["exchange", "broker"]));

  const out: AnySyncResult[] = [];
  for (const acc of rows) {
    if (acc.status === "disabled") continue;
    try {
      out.push(await syncOne(acc));
    } catch (e) {
      out.push({
        accountId: acc.id,
        ok: false,
        importedTrades: 0,
        reconciled: 0,
        error: e instanceof Error ? e.message : "Error desconocido",
      });
    }
  }
  return out;
}

export type TestResult = {
  ok: boolean;
  error?: string;
  detail?: string;
};

export async function testOne(account: Account): Promise<TestResult> {
  if (account.type === "broker") {
    if (!account.apiKeyEnc || !account.flexQueryId) {
      return { ok: false, error: "Faltan el token de Flex o el id de query" };
    }
    const r = await testIbkr(decrypt(account.apiKeyEnc), account.flexQueryId);
    return {
      ok: r.ok,
      error: r.error,
      detail: r.ok
        ? `Cuenta ${r.accountId}, ${r.trades} operaciones en el informe.`
        : undefined,
    };
  }

  if (account.type === "exchange") {
    const r = await testExchange(account);
    return {
      ok: r.ok,
      error: r.error,
      detail: r.ok ? `${r.assets} activos con saldo.` : undefined,
    };
  }

  return { ok: false, error: "Esta cuenta no se conecta por API" };
}

export async function getAccount(accountId: string): Promise<Account | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}
