import { protectedRoute } from "@/lib/api";
import { ingestNews, processNews, recentNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = protectedRoute(async (req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return Response.json({ news: await recentNews(Math.min(limit, 200)) });
});

/** Refresco manual desde la UI. */
export const POST = protectedRoute(async () => {
  const ingested = await ingestNews();
  const processed = await processNews();
  return Response.json({ ingested, processed, news: await recentNews(50) });
});
