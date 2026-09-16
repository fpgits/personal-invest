import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { syncAll } from "@/lib/sync";
import { universeTick } from "@/lib/universe-tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * De los 300 s de la funcion, hasta donde puede llegar el barrido de mercado.
 * La sincronizacion va primero porque es lo que este cron promete; el barrido
 * entra si queda sitio y, si no, espera a la siguiente pasada (hay cuatro al
 * dia y con una basta).
 */
const SWEEP_DEADLINE_MS = 200_000;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const results = await syncAll();
    // Y aqui cuelga el barrido de mercado, mientras `vercel.json` no admita su
    // cron propio. Una vez al dia, con tope dentro del tick, y nunca puede
    // tumbar la sincronizacion: si falla, se anota `null` y esto sigue.
    const universe = await universeTick({ budgetMs: SWEEP_DEADLINE_MS - (Date.now() - startedAt) }).catch(
      () => null,
    );
    return Response.json({ results, universe });
  } catch (e) {
    return errorResponse(e);
  }
}
