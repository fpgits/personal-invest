import { desc } from "drizzle-orm";
import { db } from "@/db";
import { poweroMarks } from "@/db/schema-runups";
import { cachedMonthlyPlan } from "./conviction-run";
import { markNow, proposeNow } from "./powero-run";
import { POWERO_KEYS } from "./powero-settings";
import { getSetting } from "./settings";

/**
 * El reloj de PoWERo, colgado de los crons que YA estan registrados.
 *
 * Por que existe esto y no solo `/api/cron/powero`: Vercel lee los crons
 * unicamente de `vercel.json`. Mientras ese archivo no lleve las dos lineas de
 * PoWERo, el endpoint dedicado esta publicado pero no lo llama nadie — y un
 * libro que solo se mueve cuando te acuerdas de pulsar un boton no mide el
 * oraculo, mide cuando te acuerdas tu. Enganchando el mismo trabajo a los
 * crons de precios y de foto diaria, PoWERo corre igual.
 *
 * Es idempotente a proposito: si algun dia SI se registran los crons propios,
 * los topes de abajo evitan que el trabajo se haga dos veces. No hace falta
 * quitar nada.
 *
 * Y lo de siempre: nada de esto coloca una orden real en ningun sitio.
 */

/** Como mucho una valoracion por hora: la curva no necesita mas resolucion. */
export const MARK_MIN_GAP_MS = 55 * 60_000;
/**
 * Como mucho una propuesta al dia. El oraculo se mueve con los fundamentales,
 * que cambian por trimestres; proponer mas a menudo solo gastaria EDGAR y
 * llenaria el registro de ruido.
 */
export const PROPOSE_MIN_GAP_MS = 20 * 3_600_000;

/** Puro: si toca o no, dado cuando fue la ultima vez. */
export function due(last: number | null, gapMs: number, now: number): boolean {
  if (last === null || !Number.isFinite(last)) return true;
  return now - last >= gapMs;
}

/** Ultima valoracion apuntada, de la propia tabla de marcas. */
export async function lastMarkAt(): Promise<number | null> {
  const rows = await db
    .select({ at: poweroMarks.at })
    .from(poweroMarks)
    .orderBy(desc(poweroMarks.at))
    .limit(1)
    .catch(() => [] as Array<{ at: number }>);
  return rows[0]?.at ?? null;
}

/**
 * Ultima vez que corrio el oraculo para PoWERo. Va en ajustes y no en la tabla
 * de ordenes a proposito: un dia sin operaciones tambien cuenta como corrido.
 */
export async function lastProposeAt(): Promise<number | null> {
  const raw = await getSetting(POWERO_KEYS.lastProposeAt).catch(() => null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type TickResult = {
  /** Si se apunto el patrimonio en esta pasada. */
  marked: boolean;
  /** Operaciones nuevas apuntadas en el libro nocional. */
  proposed: number;
  /** Si el veredicto del dia quedo registrado como llamada medible. */
  recorded: boolean;
  /** Lo que se salto por tope, para poder leerlo en la respuesta del cron. */
  skipped: string[];
};

/**
 * Una pasada del reloj. `propose` solo lo pide el cron diario; el de precios
 * se limita a valorar, que es barato.
 */
export async function poweroTick(
  opts: { propose?: boolean; force?: boolean } = {},
  now = Date.now(),
): Promise<TickResult> {
  const force = opts.force === true;
  const skipped: string[] = [];
  let proposed = 0;
  let recorded = false;

  if (opts.propose) {
    if (force || due(await lastProposeAt(), PROPOSE_MIN_GAP_MS, now)) {
      // El oraculo se corre AQUI y con `save`, una sola vez: deja el veredicto
      // del dia escrito en `conviction_calls` (el marcador que luego mide
      // `markForwardReturns`) y de paso llena el memo, asi que `proposeNow`
      // reutiliza este mismo plan en vez de pagar EDGAR + Finnhub otra vez.
      //
      // Esta es la diferencia entre tener opinion y tener historial: sin estas
      // filas no se puede responder nunca si el motor acierta, por muchos años
      // que pase opinando.
      recorded = await cachedMonthlyPlan({ force: true, save: true }, now)
        .then((p) => p.batchId !== null)
        .catch(() => false);
      proposed = (await proposeNow(now).catch(() => [])).length;
    } else {
      skipped.push("propose");
    }
  }

  // Si acaba de apuntarse una operacion se valora si o si: de otro modo la
  // curva iria un tick por detras de sus propias operaciones.
  const marked = force || proposed > 0 || due(await lastMarkAt(), MARK_MIN_GAP_MS, now);
  if (marked) await markNow(now).catch(() => null);
  else skipped.push("mark");

  return { marked, proposed, recorded, skipped };
}
