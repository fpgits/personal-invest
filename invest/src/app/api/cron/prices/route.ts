import { errorResponse } from "@/lib/api";
import { listAssets } from "@/lib/assets";
import { isCronAuthorized } from "@/lib/auth";
import { refreshQuotes } from "@/lib/market";

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
    return Response.json({ assets: assets.length, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
