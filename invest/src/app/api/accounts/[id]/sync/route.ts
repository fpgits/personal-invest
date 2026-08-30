import { errorResponse } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getAccount, syncOne } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * IBKR tarda: SendRequest genera el informe y hay que reintentar GetStatement
 * mientras se construye. ccxt tambien va lento por el rate limit del exchange.
 */
export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const account = await getAccount(id);
    if (!account) {
      return Response.json({ error: "Cuenta no encontrada" }, { status: 404 });
    }

    const result = await syncOne(account);
    return Response.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return errorResponse(e);
  }
}
