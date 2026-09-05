import { errorResponse } from "@/lib/api";
import { listAssets } from "@/lib/assets";
import { isCronAuthorized } from "@/lib/auth";
import { markForwardReturns } from "@/lib/conviction-calls";
import { refreshQuotes } from "@/lib/market";
import { takeSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ATTEMPTS = 3;
const RETRY_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    // Refrescamos antes de fotografiar: una foto con precios viejos o a cero
    // contamina el historico. Si faltan precios, se reintenta; si siguen
    // faltando, NO se guarda (la reconstruccion rellena el dia con cierres).
    let result = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await refreshQuotes(await listAssets()).catch(() => undefined);
      result = await takeSnapshot();
      if (result.stored) {
        // Con precios frescos, medir las llamadas del oraculo que vencen hoy.
        const marked = await markForwardReturns().catch(() => 0);
        return Response.json({
          oracleCallsMarked: marked,
          date: result.snapshot.date,
          totalValue: result.snapshot.totalValue,
          unrealizedPnl: result.snapshot.unrealizedPnl,
          stored: true,
          attempts: attempt,
        });
      }
      if (attempt < ATTEMPTS) await sleep(RETRY_MS);
    }
    return Response.json(
      { date: result?.snapshot.date, stored: false, reason: result?.reason, attempts: ATTEMPTS },
      { status: 502 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
