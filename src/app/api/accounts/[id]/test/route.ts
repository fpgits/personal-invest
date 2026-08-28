import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { errorResponse } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { testConnection } from "@/lib/exchanges/ccxt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    return Response.json(await testConnection(account));
  } catch (e) {
    return errorResponse(e);
  }
}
