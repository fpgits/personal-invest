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
  // Oraculo (se guardan como texto; se validan al leer con valores por defecto).
  [SETTING_KEYS.oracleMonthlyEquity]: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Importe no valido").optional(),
  [SETTING_KEYS.oracleMonthlyCrypto]: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Importe no valido").optional(),
  [SETTING_KEYS.oracleMaxWeightPct]: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "Peso no valido").optional(),
  [SETTING_KEYS.oracleMinTicket]: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Ticket no valido").optional(),
  [SETTING_KEYS.oracleBuyThreshold]: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "Umbral no valido").optional(),
  [SETTING_KEYS.oracleReserveSymbol]: z.string().trim().max(12).optional(),
  [SETTING_KEYS.oracleCryptoCore]: z.string().trim().max(200).optional(),
  [SETTING_KEYS.oracleContributionDay]: z.string().trim().regex(/^([1-9]|1\d|2[0-8])$/, "Dia no valido (1-28)").optional(),
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
