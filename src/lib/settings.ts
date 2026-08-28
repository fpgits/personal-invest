import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { env } from "./env";

/**
 * Ajustes editables en caliente. Lo que este aqui pisa al env,
 * para poder cambiar de modelo sin redeploy.
 */
export const SETTING_KEYS = {
  modelAnalysis: "model_analysis",
  modelFast: "model_fast",
  baseCurrency: "base_currency",
  costMethod: "cost_method", // average | fifo
} as const;

export async function getSetting(key: string): Promise<string | null> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: Date.now() },
    });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function resolveModels() {
  const all = await getAllSettings().catch(() => ({}) as Record<string, string>);
  return {
    analysis: all[SETTING_KEYS.modelAnalysis] || env.modelAnalysis,
    fast: all[SETTING_KEYS.modelFast] || env.modelFast,
  };
}

export async function resolveBaseCurrency(): Promise<string> {
  return (await getSetting(SETTING_KEYS.baseCurrency)) || env.baseCurrency;
}

export async function resolveCostMethod(): Promise<"average" | "fifo"> {
  const v = await getSetting(SETTING_KEYS.costMethod);
  return v === "fifo" ? "fifo" : "average";
}
