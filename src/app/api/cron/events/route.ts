import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { processEvents } from "@/lib/intel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Corre media hora despues del cron de noticias, sobre lo que este ya resumio. */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    return Response.json(await processEvents());
  } catch (e) {
    return errorResponse(e);
  }
}
