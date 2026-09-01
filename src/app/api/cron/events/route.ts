import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { processEvents } from "@/lib/intel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Corre media hora despues del cron de noticias, sobre lo que este ya resumio.
 * Devuelve 502 cuando el modelo no respondio (transitorio) o rechazo todo sin
 * producir nada: asi el panel de crons de Vercel lo marca en rojo en vez de
 * un 200 vacio que nadie mira.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const stats = await processEvents({ trigger: "cron" });
    const produced = stats.created + stats.updated + stats.noise + stats.attached;
    const failed = stats.transient > 0 || (stats.rejected > 0 && produced === 0);
    return Response.json(stats, { status: failed ? 502 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
