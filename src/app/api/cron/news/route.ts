import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { ingestFilings } from "@/lib/edgar";
import { ingestNews, processNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Titulares de agregadores (Finnhub) + filings primarios (SEC EDGAR), y
 * despues el resumen barato de lo que aun no lo tiene. Los filings llegan ya
 * clasificados y no pasan por el modelo.
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
    const processed = await processNews();
    return Response.json({ ingested, filings, processed });
  } catch (e) {
    return errorResponse(e);
  }
}
