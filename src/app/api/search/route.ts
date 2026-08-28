import { protectedRoute } from "@/lib/api";
import { searchAll } from "@/lib/market";

export const runtime = "nodejs";

export const GET = protectedRoute(async (req) => {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) return Response.json({ results: [] });
  const results = await searchAll(q);
  return Response.json({ results });
});
