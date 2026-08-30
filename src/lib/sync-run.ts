import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { syncRuns } from "@/db/schema";
import { id } from "./utils";

const STALE_AFTER_MS = 10 * 60 * 1000;

export type SyncRunHandle = {
  runId: string;
  finish: (patch: {
    status: "ok" | "error";
    imported?: number;
    error?: string;
  }) => Promise<void>;
};

/**
 * Abre un registro de sync para una cuenta, con guarda de concurrencia:
 * si el cron y un click manual coinciden, la reconciliacion se ejecutaria dos
 * veces y duplicaria los ajustes de saldo. El segundo en llegar recibe null.
 *
 * Los runs colgados de mas de 10 minutos (una funcion que murio a mitad) se
 * marcan como error para que no bloqueen para siempre.
 */
export async function startSyncRun(
  accountId: string,
): Promise<SyncRunHandle | null> {
  const now = Date.now();

  await db
    .update(syncRuns)
    .set({
      status: "error",
      finishedAt: now,
      error: "Interrumpido: la ejecucion anterior no termino",
    })
    .where(
      and(
        eq(syncRuns.accountId, accountId),
        eq(syncRuns.status, "running"),
        lt(syncRuns.startedAt, now - STALE_AFTER_MS),
      ),
    );

  const active = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(eq(syncRuns.accountId, accountId), eq(syncRuns.status, "running")),
    )
    .limit(1);

  if (active.length > 0) return null;

  const runId = id();
  await db.insert(syncRuns).values({
    id: runId,
    accountId,
    startedAt: now,
    status: "running",
  });

  return {
    runId,
    finish: async (patch) => {
      await db
        .update(syncRuns)
        .set({
          status: patch.status,
          imported: patch.imported ?? 0,
          error: patch.error ?? null,
          finishedAt: Date.now(),
        })
        .where(eq(syncRuns.id, runId));
    },
  };
}

export const SYNC_BUSY_ERROR =
  "Ya hay una sincronizacion en curso para esta cuenta. Espera a que termine.";
