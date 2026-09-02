import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { refreshFundamentals } from "@/lib/fundamentals";
import { syncManagers } from "@/lib/managers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pasada diaria de datos primarios lentos:
 * - fundamentales basicos de las acciones seguidas (Finnhub; cada activo se
 *   refresca si tiene mas de 7 dias);
 * - 13F nuevos de los gestores seguidos (EDGAR), con el tiempo que quede.
 * Un fallo en una parte no tumba la otra: cada bloque reporta su error.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const started = Date.now();
  try {
    const fundamentals = await refreshFundamentals().catch((e: unknown) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    const managers = await syncManagers({}, { deadline: started + 250_000 });
    return Response.json({ fundamentals, managers });
  } catch (e) {
    return errorResponse(e);
  }
}
