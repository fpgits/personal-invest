import { protectedRoute } from "@/lib/api";
import { historySummary, rebuildHistory } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Cierres de cada activo + informe Flex de IBKR: puede tardar un par de minutos. */
export const maxDuration = 300;

/** Estado del historico de snapshots. */
export const GET = protectedRoute(async () => {
  return Response.json(await historySummary());
});

/** Reconstruye el historico hasta ayer con el libro de operaciones y cierres diarios. */
export const POST = protectedRoute(async () => {
  const report = await rebuildHistory();
  return Response.json({ report, summary: await historySummary() });
});
