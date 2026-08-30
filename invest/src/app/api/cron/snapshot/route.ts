import { errorResponse } from "@/lib/api";
import { listAssets } from "@/lib/assets";
import { isCronAuthorized } from "@/lib/auth";
import { refreshQuotes } from "@/lib/market";
import { takeSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    // Refrescamos antes de fotografiar: una foto con precios viejos
    // contamina el historico para siempre.
    await refreshQuotes(await listAssets()).catch(() => undefined);
    const snap = await takeSnapshot();
    return Response.json({
      date: snap.date,
      totalValue: snap.totalValue,
      unrealizedPnl: snap.unrealizedPnl,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
