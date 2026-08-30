import { errorResponse } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getAccount, testOne } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    return Response.json(await testOne(account));
  } catch (e) {
    return errorResponse(e);
  }
}
