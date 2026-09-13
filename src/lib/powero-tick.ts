import { cachedMonthlyPlan } from "./conviction-run";
import { lastMarkAt, lastProposeAt, markNow, proposeNow } from "./powero-run";
import { due, MARK_MIN_GAP_MS, PROPOSE_MIN_GAP_MS } from "./powero-settings";

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
 * los topes evitan que el trabajo se haga dos veces. No hace falta quitar nada.
 *
 * Y lo de siempre: nada de esto coloca una orden real.
 */

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
      // Solo el reloj sella la fecha: una pulsacion del boton no puede correr
      // la cita del dia siguiente.
      proposed = (await proposeNow(now, { stamp: true }).catch(() => [])).length;
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
