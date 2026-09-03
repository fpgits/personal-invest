import { desc, gte } from "drizzle-orm";
import { db } from "@/db";
import { aiCalls } from "@/db/schema";
import { budgetStatus } from "@/lib/ai/client";
import { AI_POLICY, summarizeCalls, type AiUsageResponse } from "@/lib/ai/policy";
import { protectedRoute } from "@/lib/api";
import { resolveModels } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uso y coste de la IA: hoy, 7 dias, 30 dias, por tipo de llamada, y el estado del presupuesto. */
export const GET = protectedRoute(async () => {
  const now = Date.now();
  const [rows, budget, models] = await Promise.all([
    db
      .select()
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, now - 30 * 86400_000))
      .orderBy(desc(aiCalls.createdAt))
      .limit(5000),
    budgetStatus(now),
    resolveModels(),
  ]);
  const body: AiUsageResponse = { ...summarizeCalls(rows, now), budget, models, policy: AI_POLICY };
  return Response.json(body);
});
