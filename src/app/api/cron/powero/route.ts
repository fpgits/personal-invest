import { isCronAuthorized } from "@/lib/auth";
import { poweroTick } from "@/lib/powero-tick";
import { resolvePoweroSettings } from "@/lib/powero-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Proponer corre el oraculo entero: EDGAR + Finnhub + FRED sobre la cartera.
export const maxDuration = 300;

/**
 * El reloj de PoWERo. Es lo que convierte el libro en un instrumento de
 * medida en vez de en una pantalla que miras cuando te acuerdas: si solo
 * midiera al pulsar un boton, el sesgo lo pondrias tu al elegir cuando mirar.
 *
 * Dos cosas, y en este orden:
 *  1. VALORAR siempre. Cada pasada apunta el patrimonio de los dos libros y el
 *     del indice al mismo instante. De ahi salen las dos curvas.
 *  2. PROPONER una vez al dia (`?propose=1`). El oraculo se mueve con los
 *     fundamentales, que cambian por trimestres: proponer mas a menudo solo
 *     gastaria EDGAR y ensuciaria el registro.
 *
 * En modo automatico la propuesta se apunta sola en el libro NOCIONAL. Sigue
 * sin tocar ningun broker: aqui no hay ninguna orden real, ni la habra.
 *
 * OJO: este endpoint solo se ejecuta si `vercel.json` lo lista. Mientras no lo
 * haga, el mismo trabajo lo hacen los crons de precios y de foto diaria a
 * traves de `poweroTick`, que es exactamente lo que se llama aqui. Por eso los
 * dos caminos pueden convivir sin duplicar nada: los topes viven en el tick.
 * `?force=1` se los salta, para poder disparar a mano.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const propose = params.get("propose") === "1";
  try {
    const settings = await resolvePoweroSettings();
    const tick = await poweroTick({ propose, force: params.get("force") === "1" });
    return Response.json({
      mode: settings.mode,
      proposed: tick.proposed,
      executed: settings.mode === "auto" ? tick.proposed : 0,
      /** El veredicto del dia, guardado como llamada medible. */
      callsRecorded: tick.recorded,
      marked: tick.marked,
      skipped: tick.skipped,
      asOf: Date.now(),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "fallo" }, { status: 500 });
  }
}
