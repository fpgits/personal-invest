import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, syncRuns } from "@/db/schema";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { encrypt, maskKey } from "@/lib/crypto";
import { SUPPORTED_EXCHANGES, isSupported } from "@/lib/exchanges/ccxt";
import { id } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    name: z.string().min(1).max(60),
    type: z.enum(["exchange", "broker", "wallet", "manual"]),
    exchangeId: z.string().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    apiPassphrase: z.string().optional(),
  })
  .refine(
    (v) =>
      v.type !== "exchange" ||
      (Boolean(v.exchangeId) && Boolean(v.apiKey) && Boolean(v.apiSecret)),
    { message: "Una cuenta de exchange necesita exchangeId, apiKey y apiSecret" },
  );

export const GET = protectedRoute(async () => {
  const rows = await db.select().from(accounts).orderBy(desc(accounts.createdAt));
  const runs = await db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(50);

  // Nunca devolvemos las claves, solo los ultimos 4 caracteres.
  return Response.json({
    accounts: rows.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      exchangeId: a.exchangeId,
      status: a.status,
      lastSyncAt: a.lastSyncAt,
      lastError: a.lastError,
      createdAt: a.createdAt,
      apiKeyMasked: maskKey(a.apiKeyEnc),
      hasCredentials: Boolean(a.apiKeyEnc && a.apiSecretEnc),
    })),
    recentRuns: runs,
    supportedExchanges: SUPPORTED_EXCHANGES,
  });
});

export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, createSchema);

  if (body.type === "exchange" && !isSupported(body.exchangeId!)) {
    return Response.json(
      { error: `Exchange no soportado: ${body.exchangeId}` },
      { status: 400 },
    );
  }

  const row = {
    id: id(),
    name: body.name,
    type: body.type,
    exchangeId: body.exchangeId ?? null,
    apiKeyEnc: body.apiKey ? encrypt(body.apiKey) : null,
    apiSecretEnc: body.apiSecret ? encrypt(body.apiSecret) : null,
    apiPassphraseEnc: body.apiPassphrase ? encrypt(body.apiPassphrase) : null,
    status: "active",
    lastSyncAt: null,
    lastError: null,
    createdAt: Date.now(),
  };

  await db.insert(accounts).values(row);
  return ok({ id: row.id });
});

export const DELETE = protectedRoute(async (req) => {
  const accountId = new URL(req.url).searchParams.get("id");
  if (!accountId) return Response.json({ error: "Falta el id" }, { status: 400 });
  await db.delete(accounts).where(eq(accounts.id, accountId));
  return ok();
});
