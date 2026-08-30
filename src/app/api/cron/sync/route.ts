import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { syncAll } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    return Response.json({ results: await syncAll() });
  } catch (e) {
    return errorResponse(e);
  }
}
