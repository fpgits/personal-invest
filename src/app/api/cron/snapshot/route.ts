import { errorResponse } from "@/lib/api";
import { listAssets } from "@/lib/assets";
import { isCronAuthorized } from "@/lib/auth";
import { markForwardReturns } from "@/lib/conviction-calls";
import { refreshQuotes } from "@/lib/market";
import { poweroTick } from "@/lib/powero-tick";
import { takeSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ATTEMPTS = 3;
const RETRY_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Correr el oraculo entero para PoWERo tarda. Si la foto ya se ha comido buena
 * parte del presupuesto reintentando, esta pasada solo valora y la propuesta
 * espera a manana: mejor un dia sin operacion que una funcion cortada a medias.
 */
const PROPOSE_BUDGET_MS = 90_000;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    // Refrescamos antes de fotografiar: una foto con precios viejos o a cero
    // contamina el historico. Si faltan precios, se reintenta; si siguen
    // faltando, NO se guarda (la reconstruccion rellena el dia con cierres).
    let result = null;
    let oracleCallsMarked = 0;
    let stored = false;
    let attempts = ATTEMPTS;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await refreshQuotes(await listAssets()).catch(() => undefined);
      result = await takeSnapshot();
      if (result.stored) {
        // Con precios frescos, medir las llamadas del oraculo que vencen hoy.
        oracleCallsMarked = await markForwardReturns().catch(() => 0);
        stored = true;
        attempts = attempt;
        break;
      }
      if (attempt < ATTEMPTS) await sleep(RETRY_MS);
    }

    // Y aqui cuelga PoWERo. Este es el momento correcto del dia: despues del
    // cierre de EEUU y con los precios ya refrescados. Corre pase lo que pase
    // con la foto — son dos cosas independientes — y nunca puede tumbar este
    // cron: si falla, se anota `null` y la foto sigue su camino.
    const powero = await poweroTick({
      propose: Date.now() - startedAt < PROPOSE_BUDGET_MS,
    }).catch(() => null);

    if (!stored) {
      return Response.json(
        { date: result?.snapshot.date, stored: false, reason: result?.reason, attempts: ATTEMPTS, powero },
        { status: 502 },
      );
    }
    return Response.json({
      oracleCallsMarked,
      date: result?.snapshot.date,
      totalValue: result?.snapshot.totalValue,
      unrealizedPnl: result?.snapshot.unrealizedPnl,
      stored: true,
      attempts,
      powero,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
