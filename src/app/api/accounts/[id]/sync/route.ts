import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { errorResponse } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { syncAccount } from "@/lib/exchanges/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ccxt puede tardar: varios pares por moneda con rate limit del exchange.
export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    const account = rows[0];
    if (!account) {
      return Response.json({ error: "Cuenta no encontrada" }, { status: 404 });
    }
    if (account.type !== "exchange") {
      return Response.json(
        { error: "Solo las cuentas de exchange se sincronizan por API" },
        { status: 400 },
      );
    }

    const result = await syncAccount(account);
    return Response.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return errorResponse(e);
  }
}
