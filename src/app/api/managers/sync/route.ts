import { protectedRoute } from "@/lib/api";
import { listManagers, syncManagers } from "@/lib/managers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Pasada manual: busca 13F nuevos de todos los gestores activos. */
export const POST = protectedRoute(async () => {
  const results = await syncManagers({}, { deadline: Date.now() + 240_000 });
  return Response.json({ results, managers: await listManagers() });
});
