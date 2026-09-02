import { protectedRoute } from "@/lib/api";
import { ingestFilings } from "@/lib/edgar";
import { ingestNews, newsLastError, processNews, recentNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = protectedRoute(async (req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const safe = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 200) : 50;
  const [items, lastError] = await Promise.all([recentNews(safe), newsLastError()]);
  return Response.json({ news: items, lastError });
});

/** Refresco manual desde la UI: titulares, filings y resumen. */
export const POST = protectedRoute(async () => {
  const ingested = await ingestNews();
  const filings = await ingestFilings().catch((e: unknown) => ({
    companies: 0,
    scanned: 0,
    inserted: 0,
    errors: 1,
    error: e instanceof Error ? e.message : String(e),
  }));
  const processed = await processNews();
  const [items, lastError] = await Promise.all([recentNews(50), newsLastError()]);
  return Response.json({ ingested, filings, processed, news: items, lastError });
});
