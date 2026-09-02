import { protectedRoute } from "@/lib/api";
import { searchManagers } from "@/lib/managers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Busca gestores por nombre en EDGAR (autocompletado de la SEC). */
export const GET = protectedRoute(async (req) => {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return Response.json({ hits: [] });
  return Response.json({ hits: await searchManagers(q) });
});
