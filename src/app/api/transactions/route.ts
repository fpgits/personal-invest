import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, assets, transactions } from "@/db/schema";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { ensureAsset } from "@/lib/assets";
import { id } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  symbol: z.string().min(1).max(20),
  assetClass: z.enum(["equity", "etf", "crypto"]),
  type: z.enum(["buy", "sell", "dividend", "fee", "transfer_in", "transfer_out"]),
  quantity: z.number().positive(),
  price: z.number().min(0),
  fee: z.number().min(0).default(0),
  currency: z.string().length(3).default("USD"),
  executedAt: z.number().int().positive(),
  accountId: z.string().optional(),
  note: z.string().max(500).optional(),
});

/** Toda transaccion necesita una cuenta. Si no hay ninguna, creamos "Manual". */
export async function defaultAccountId(): Promise<string> {
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.type, "manual"))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const row = {
    id: id(),
    name: "Manual",
    type: "manual",
    status: "active",
    createdAt: Date.now(),
  };
  await db.insert(accounts).values(row);
  return row.id;
}

export const GET = protectedRoute(async (req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
  const rows = await db
    .select({ tx: transactions, asset: assets, account: accounts })
    .from(transactions)
    .innerJoin(assets, eq(transactions.assetId, assets.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .orderBy(desc(transactions.executedAt))
    .limit(Math.min(limit, 1000));
  return Response.json({ transactions: rows });
});

export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, createSchema);
  const asset = await ensureAsset({
    symbol: body.symbol,
    assetClass: body.assetClass,
  });
  const accountId = body.accountId ?? (await defaultAccountId());

  const row = {
    id: id(),
    accountId,
    assetId: asset.id,
    type: body.type,
    quantity: body.quantity,
    price: body.price,
    fee: body.fee,
    currency: body.currency.toUpperCase(),
    executedAt: body.executedAt,
    externalId: null,
    source: "manual",
    note: body.note ?? null,
    createdAt: Date.now(),
  };
  await db.insert(transactions).values(row);
  return ok({ transaction: row, asset });
});

export const DELETE = protectedRoute(async (req) => {
  const txId = new URL(req.url).searchParams.get("id");
  if (!txId) return Response.json({ error: "Falta el id" }, { status: 400 });
  await db.delete(transactions).where(eq(transactions.id, txId));
  return ok();
});
