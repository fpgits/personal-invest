import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { ingestFilings } from "@/lib/edgar";
import { ingestInsiders } from "@/lib/insiders";
import { ingestNews, processNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Titulares de agregadores (Finnhub + Google News) + filings primarios (SEC
 * EDGAR: 8-K, 10-Q, 13D/13G) + insiders (Form 4, sin IA), y despues el
 * resumen barato de lo que aun no lo tiene.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const ingested = await ingestNews();
    const filings = await ingestFilings().catch((e: unknown) => ({
      companies: 0,
      scanned: 0,
      inserted: 0,
      errors: 1,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (filings.error) console.warn("[edgar]", filings.error);
    // Form 4 (insiders): fuente primaria, sin IA. Mejor esfuerzo.
    const insiders = await ingestInsiders().catch((e: unknown) => ({
      companies: 0,
      filings: 0,
      transactions: 0,
      signals: 0,
      errors: 1,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (insiders.error) console.warn("[insiders]", insiders.error);
    const processed = await processNews();
    return Response.json({ ingested, filings, insiders, processed });
  } catch (e) {
    return errorResponse(e);
  }
}
