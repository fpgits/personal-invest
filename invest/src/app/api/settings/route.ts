import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { SETTING_KEYS, getAllSettings, setSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  [SETTING_KEYS.modelAnalysis]: z.string().max(120).optional(),
  [SETTING_KEYS.modelFast]: z.string().max(120).optional(),
  [SETTING_KEYS.baseCurrency]: z.string().length(3).optional(),
  [SETTING_KEYS.costMethod]: z.enum(["average", "fifo"]).optional(),
});

export const GET = protectedRoute(async () => {
  return Response.json({ settings: await getAllSettings() });
});

export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, schema);
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && value.length > 0) {
      await setSetting(key, value);
    }
  }
  return ok({ settings: await getAllSettings() });
});
