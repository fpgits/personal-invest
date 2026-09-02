import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { refreshFundamentals } from "@/lib/fundamentals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Fundamentales basicos de las acciones seguidas (Finnhub). Diario; cada activo se refresca si tiene mas de 7 dias. */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    return Response.json(await refreshFundamentals());
  } catch (e) {
    return errorResponse(e);
  }
}
