import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { syncAllAccounts } from "@/lib/exchanges/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    return Response.json({ results: await syncAllAccounts() });
  } catch (e) {
    return errorResponse(e);
  }
}
