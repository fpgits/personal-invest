import { desc } from "drizzle-orm";
import { db } from "@/db";
import { universeRuns } from "@/db/schema-universe";
import { sweepCrypto, type CryptoSweepResult } from "./crypto-universe-run";
import { sweepMarket, type SweepResult } from "./universe-run";

/**
 * El reloj del barrido de mercado, colgado de un cron que YA existe.
 *
 * Misma historia que `powero-tick.ts`: `vercel.json` sigue sin poder
 * escribirse en el equipo (Windows deniega el acceso a ese archivo y solo a
 * ese), asi que `/api/cron/universe` esta publicado y nadie lo llama. Mientras
 * tanto, esto corre dentro del cron de sincronizacion, que pasa cuatro veces
 * al dia, y hace el barrido UNA vez por dia: la primera pasada que encuentra
 * que hoy no se ha hecho.
 *
 * Es idempotente a proposito. El dia que las cuatro lineas entren en
 * `vercel.json`, el cron propio y este se pisan sin duplicar nada: quien llegue
 * primero barre, el otro ve la fila de hoy y se va.
 *
 * Por que una vez al dia basta: los frames que se bajan son ejercicios
 * ANUALES (CY2018..CY2025). No cambian con la sesion; cambian cuando un
 * declarante tardio presenta o alguien reformula, que es cosa de semanas.
 */

export type UniverseTickResult = {
  ran: boolean;
  /** Por que no corrio, cuando no corrio. */
  skipped: string | null;
  bolsa: SweepResult | { error: string } | null;
  cripto: CryptoSweepResult | { error: string } | null;
};

/** Fecha (YYYY-MM-DD, UTC) de la ultima pasada que llego a escribir. */
export async function lastSweepDate(): Promise<string | null> {
  const rows = await db
    .select({ sourceDate: universeRuns.sourceDate })
    .from(universeRuns)
    .orderBy(desc(universeRuns.at))
    .limit(1)
    .catch(() => [] as Array<{ sourceDate: string }>);
  return rows[0]?.sourceDate ?? null;
}

/** Si hoy toca: no hay pasada apuntada con la fecha de hoy. Puro. */
export function sweepDue(last: string | null, now: number): boolean {
  return last !== new Date(now).toISOString().slice(0, 10);
}

/**
 * Una pasada. `budgetMs` es el tiempo que le queda a la funcion que nos
 * llama: si el trabajo previo se comio el presupuesto, el barrido espera a
 * la siguiente pasada del cron en vez de dejar una funcion cortada a medias
 * con la tabla escrita por la mitad.
 */
export async function universeTick(
  opts: { force?: boolean; budgetMs?: number } = {},
  now = Date.now(),
): Promise<UniverseTickResult> {
  const out: UniverseTickResult = { ran: false, skipped: null, bolsa: null, cripto: null };
  if (!opts.force && !sweepDue(await lastSweepDate(), now)) {
    out.skipped = "ya barrido hoy";
    return out;
  }
  if (opts.budgetMs !== undefined && opts.budgetMs < MIN_BUDGET_MS) {
    out.skipped = "sin tiempo en esta pasada";
    return out;
  }
  // Los dos lados a la vez y cada uno con su propio fallo, igual que en el
  // cron dedicado: si la SEC no contesta, el universo cripto no se cae con
  // ella.
  const [bolsa, cripto] = await Promise.all([
    sweepMarket({ now }).catch((e) => ({ error: e instanceof Error ? e.message : "fallo" })),
    sweepCrypto({ now }).catch((e) => ({ error: e instanceof Error ? e.message : "fallo" })),
  ]);
  out.ran = true;
  out.bolsa = bolsa;
  out.cripto = cripto;
  return out;
}

/**
 * Lo minimo que necesita el barrido: 144 peticiones a 8/s son 18 s, mas armar
 * y escribir unos miles de filas. Con menos de esto no se empieza.
 */
export const MIN_BUDGET_MS = 120_000;
