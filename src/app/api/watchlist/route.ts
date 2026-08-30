import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { assets, watchlist } from "@/db/schema";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { ensureAsset } from "@/lib/assets";
import { getQuotes, type CachedQuote } from "@/lib/market";
import { id } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addSchema = z.object({
  symbol: z.string().min(1).max(20),
  assetClass: z.enum(["equity", "etf", "crypto"]),
  providerId: z.string().optional(),
  name: z.string().optional(),
  note: z.string().max(500).optional(),
  targetPrice: z.number().positive().optional(),
  alertDirection: z.enum(["above", "below"]).optional(),
});

export const GET = protectedRoute(async () => {
  const rows = await db
    .select({ entry: watchlist, asset: assets })
    .from(watchlist)
    .innerJoin(assets, eq(watchlist.assetId, assets.id));

  const quotes = await getQuotes(rows.map((r) => r.asset)).catch(
    () => ({}) as Record<string, CachedQuote>,
  );
  return Response.json({
    items: rows.map((r) => ({ ...r, quote: quotes[r.asset.id] ?? null })),
  });
});

export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, addSchema);
  const asset = await ensureAsset({
    symbol: body.symbol,
    assetClass: body.assetClass,
    providerId: body.providerId,
    name: body.name,
  });

  await db
    .insert(watchlist)
    .values({
      id: id(),
      assetId: asset.id,
      note: body.note ?? null,
      targetPrice: body.targetPrice ?? null,
      alertDirection: body.alertDirection ?? null,
      addedAt: Date.now(),
    })
    .onConflictDoNothing();

  return ok({ asset });
});

export const DELETE = protectedRoute(async (req) => {
  const assetId = new URL(req.url).searchParams.get("assetId");
  if (!assetId) return Response.json({ error: "Falta assetId" }, { status: 400 });
  await db.delete(watchlist).where(eq(watchlist.assetId, assetId));
  return ok();
});
