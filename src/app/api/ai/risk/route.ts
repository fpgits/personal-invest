import { aiText } from "@/lib/ai/client";
import { portfolioToText } from "@/lib/ai/context";
import { RISK_SYSTEM } from "@/lib/ai/prompts";
import { protectedRoute } from "@/lib/api";
import { computePortfolio } from "@/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = protectedRoute(async () => {
  const portfolio = await computePortfolio();
  if (portfolio.positions.length === 0) {
    return Response.json(
      { error: "No hay posiciones que analizar todavia" },
      { status: 400 },
    );
  }

  const { text, modelId } = await aiText("risk", {
    system: RISK_SYSTEM,
    prompt: portfolioToText(portfolio),
    temperature: 0.3,
  });

  return Response.json({ analysis: text, model: modelId, at: Date.now() });
});
