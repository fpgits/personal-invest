import { z } from "zod";
import { parseBody, protectedRoute } from "@/lib/api";
import { decide, markNow, poweroState, proposeNow, resetBook } from "@/lib/powero-run";
import { POWERO_KEYS } from "@/lib/powero-settings";
import { setSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Proponer corre el oraculo entero si no esta en cache.
export const maxDuration = 300;

/** Estado del libro nocional: valoracion, propuestas vivas, registro y curva. */
export const GET = protectedRoute(async () => {
  return Response.json(await poweroState());
});

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose") }),
  z.object({ action: z.literal("mark") }),
  z.object({ action: z.literal("decide"), orderId: z.string().min(1), decision: z.enum(["executed", "discarded"]) }),
  z.object({ action: z.literal("reset"), book: z.enum(["equity", "crypto"]) }),
  z.object({
    action: z.literal("settings"),
    equityCapital: z.number().positive().max(100_000_000).optional(),
    cryptoCapital: z.number().positive().max(100_000_000).optional(),
    mode: z.enum(["manual", "auto"]).optional(),
  }),
]);

/**
 * Acciones del libro. Ninguna toca un broker: `decide` con "executed" apunta
 * la operacion en el libro nocional, nada mas.
 */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, schema);

  if (body.action === "propose") {
    const created = await proposeNow();
    return Response.json({ created, asOf: Date.now() });
  }
  if (body.action === "mark") {
    return Response.json({ equity: await markNow(), asOf: Date.now() });
  }
  if (body.action === "decide") {
    const ok = await decide(body.orderId, body.decision);
    // Cada decision mueve el libro: se apunta el patrimonio al momento para
    // que la curva no tenga escalones invisibles entre dos fotos del cron.
    if (ok) await markNow().catch(() => null);
    return Response.json({ ok });
  }
  if (body.action === "reset") {
    await resetBook(body.book);
    return Response.json({ ok: true });
  }

  if (body.equityCapital !== undefined) {
    await setSetting(POWERO_KEYS.equityCapital, String(body.equityCapital));
  }
  if (body.cryptoCapital !== undefined) {
    await setSetting(POWERO_KEYS.cryptoCapital, String(body.cryptoCapital));
  }
  if (body.mode !== undefined) await setSetting(POWERO_KEYS.mode, body.mode);
  return Response.json({ ok: true });
});
