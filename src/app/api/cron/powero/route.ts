import { isCronAuthorized } from "@/lib/auth";
import { markNow, proposeNow } from "@/lib/powero-run";
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
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const propose = new URL(req.url).searchParams.get("propose") === "1";
  try {
    const settings = await resolvePoweroSettings();
    // Proponer va PRIMERO para que la valoracion de esta misma pasada ya
    // incluya lo que se acabe de apuntar; si no, la curva iria un tick por
    // detras de sus propias operaciones.
    const created = propose ? await proposeNow().catch(() => []) : [];
    const equity = await markNow();
    return Response.json({
      mode: settings.mode,
      proposed: created.length,
      recorded: settings.mode === "auto" ? created.length : 0,
      equity,
      asOf: Date.now(),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "fallo" }, { status: 500 });
  }
}
