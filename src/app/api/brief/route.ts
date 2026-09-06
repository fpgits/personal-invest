import { protectedRoute } from "@/lib/api";
import { getBrief } from "@/lib/brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * "Que hacer": el resumen en lenguaje llano de esta semana y este mes.
 * ?force=1 recalcula saltandose la cache de 30 minutos.
 */
export const GET = protectedRoute(async (req) => {
  const force = new URL(req.url).searchParams.get("force") === "1";
  return Response.json(await getBrief({ force }));
});
