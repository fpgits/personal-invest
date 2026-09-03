import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { theses } from "@/db/schema";
import { aiText } from "@/lib/ai/client";
import { THESIS_SYSTEM } from "@/lib/ai/prompts";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { ensureAsset } from "@/lib/assets";
import { computePortfolio } from "@/lib/portfolio";
import { fmtMoney, fmtPct, fmtQty, id } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const generateSchema = z.object({
  symbol: z.string().min(1).max(20),
  assetClass: z.enum(["equity", "etf", "crypto"]),
});

const saveSchema = z.object({
  symbol: z.string().min(1).max(20),
  assetClass: z.enum(["equity", "etf", "crypto"]),
  thesis: z.string().min(1).max(20000),
  conviction: z.number().int().min(1).max(5).optional(),
  targetPrice: z.number().positive().optional(),
  horizon: z.string().max(60).optional(),
});

export const GET = protectedRoute(async () => {
  return Response.json({ theses: await db.select().from(theses) });
});

/** Genera una tesis con IA. No la guarda: eso lo decide el usuario. */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, generateSchema);
  const asset = await ensureAsset({
    symbol: body.symbol,
    assetClass: body.assetClass,
  });

  const portfolio = await computePortfolio();
  const pos = portfolio.positions.find((p) => p.asset.id === asset.id);

  const position = pos
    ? [
        `Fernando tiene una posicion abierta en ${asset.symbol}:`,
        `- cantidad: ${fmtQty(pos.quantity)}`,
        `- coste medio: ${fmtMoney(pos.avgCost, portfolio.currency)}`,
        `- precio actual: ${fmtMoney(pos.price, portfolio.currency)}`,
        `- P&L no realizado: ${fmtMoney(pos.unrealizedPnl, portfolio.currency)} (${fmtPct(pos.unrealizedPct)})`,
        `- peso en la cartera: ${pos.weight.toFixed(1)}%`,
      ].join("\n")
    : `Fernando no tiene posicion abierta en ${asset.symbol}.`;

  const { text, modelId } = await aiText("thesis_text", {
    system: THESIS_SYSTEM,
    prompt: `Activo: ${asset.symbol} (${asset.name}), clase ${asset.assetClass}.\n\n${position}`,
    temperature: 0.5,
  });

  return Response.json({ thesis: text, model: modelId, asset });
});

/** Guarda o actualiza la tesis de un activo. */
export const PUT = protectedRoute(async (req) => {
  const body = await parseBody(req, saveSchema);
  const asset = await ensureAsset({
    symbol: body.symbol,
    assetClass: body.assetClass,
  });

  const existing = await db
    .select()
    .from(theses)
    .where(eq(theses.assetId, asset.id))
    .limit(1);

  const values = {
    thesis: body.thesis,
    conviction: body.conviction ?? null,
    targetPrice: body.targetPrice ?? null,
    horizon: body.horizon ?? null,
    generatedBy: "manual",
    updatedAt: Date.now(),
  };

  if (existing[0]) {
    await db.update(theses).set(values).where(eq(theses.id, existing[0].id));
  } else {
    await db.insert(theses).values({ id: id(), assetId: asset.id, ...values });
  }
  return ok();
});
