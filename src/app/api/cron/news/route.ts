import { errorResponse } from "@/lib/api";
import { isCronAuthorized } from "@/lib/auth";
import { ingestNews, processNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const ingested = await ingestNews();
    const processed = await processNews();
    return Response.json({ ingested, processed });
  } catch (e) {
    return errorResponse(e);
  }
}
