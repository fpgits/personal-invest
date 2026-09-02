import { protectedRoute } from "@/lib/api";
import { parseSpec, resolveStored, todayUtc } from "@/lib/period";
import { dashboardPeriod } from "@/lib/period-metrics";
import { computePortfolio } from "@/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Metricas del Resumen para un periodo. El cliente manda el mismo spec que
 * guarda en la cookie, asi la respuesta corresponde exactamente a lo que
 * muestra el selector (nada de esperar a que el servidor relea la cookie).
 */
export const GET = protectedRoute(async (req) => {
  const raw = new URL(req.url).searchParams.get("spec");
  const spec = parseSpec(raw ? decodeURIComponent(raw) : null);
  const period = resolveStored(spec, todayUtc());
  const live = await computePortfolio();
  return Response.json(await dashboardPeriod(period, live, spec.today));
});
