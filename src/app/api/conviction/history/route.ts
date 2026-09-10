import { protectedRoute } from "@/lib/api";
import { listCalls, summarizeCalls, summarizeCycleCalls, summarizeSpecialCalls } from "@/lib/conviction-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Historial del oraculo: llamadas registradas con su retorno a 30/90/180/365
 * dias y el resumen por postura (tasa de acierto, retorno medio) frente al
 * indice de referencia. Es la credibilidad del oraculo, medida.
 */
export const GET = protectedRoute(async () => {
  const calls = await listCalls(300);
  return Response.json({
    calls,
    stats: summarizeCalls(calls),
    cycleStats: summarizeCycleCalls(calls),
    specialStats: summarizeSpecialCalls(calls),
    asOf: Date.now(),
  });
});
