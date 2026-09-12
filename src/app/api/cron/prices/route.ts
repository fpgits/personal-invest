import { errorResponse } from "@/lib/api";
import { listAssets } from "@/lib/assets";
import { isCronAuthorized } from "@/lib/auth";
import { refreshQuotes } from "@/lib/market";
import { poweroTick } from "@/lib/powero-tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const assets = await listAssets();
    const result = await refreshQuotes(assets);
    // Con los precios recien refrescados, se apunta el patrimonio de los libros
    // nocionales. Da a la curva puntos DURANTE la sesion y no solo al cierre.
    // Barato: leer ordenes y multiplicar. Con tope horario dentro del tick.
    const powero = await poweroTick().catch(() => null);
    return Response.json({ assets: assets.length, ...result, powero });
  } catch (e) {
    return errorResponse(e);
  }
}
