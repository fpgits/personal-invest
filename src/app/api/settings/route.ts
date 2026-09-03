import { z } from "zod";
import { invalidateBudget } from "@/lib/ai/client";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { SETTING_KEYS, getAllSettings, setSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  [SETTING_KEYS.modelAnalysis]: z.string().max(120).optional(),
  [SETTING_KEYS.modelFast]: z.string().max(120).optional(),
  [SETTING_KEYS.baseCurrency]: z.string().length(3).optional(),
  [SETTING_KEYS.costMethod]: z.enum(["average", "fifo"]).optional(),
  /** USD al dia; "0" = sin limite. Se guarda como texto, como todo en settings. */
  [SETTING_KEYS.aiDailyBudget]: z
    .string()
    .trim()
    .regex(/^\d{1,5}(\.\d{1,2})?$/, "Presupuesto no valido")
    .optional(),
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
  if (body[SETTING_KEYS.aiDailyBudget] !== undefined) invalidateBudget();
  return ok({ settings: await getAllSettings() });
});
