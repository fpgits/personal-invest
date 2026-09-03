import { protectedRoute } from "@/lib/api";
import { ingestFilings } from "@/lib/edgar";
import { parseGroup } from "@/lib/group";
import { ingestNews, newsLastError, processNews, recentNews } from "@/lib/news";
import { periodBounds } from "@/lib/period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GET = protectedRoute(async (req) => {
  const params = new URL(req.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const safe = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 200) : 50;
  const from = params.get("from");
  const to = params.get("to");
  const window = from && to && ISO_DAY.test(from) && ISO_DAY.test(to) ? periodBounds({ from, to }) : {};
  const group = parseGroup(params.get("group"));
  const [items, lastError] = await Promise.all([recentNews(safe, window, group), newsLastError()]);
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
