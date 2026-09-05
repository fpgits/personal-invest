import { protectedRoute } from "@/lib/api";
import { runConviction } from "@/lib/conviction-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Veredicto de conviccion sobre la cartera: comprar / mantener / reducir /
 * vender por posicion, con puntuacion, factores y valor razonable. Determinista
 * (sin IA) y de solo lectura: aconseja, no opera.
 */
export const GET = protectedRoute(async () => {
  const run = await runConviction();
  return Response.json(run);
});
