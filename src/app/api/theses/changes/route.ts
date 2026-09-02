import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { resolveProposal } from "@/lib/thesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(1).max(64),
  accept: z.boolean(),
});

/** Acepta (aplica) o rechaza una propuesta de cambio de tesis. */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, schema);
  const done = await resolveProposal(body.id, body.accept);
  if (!done) return Response.json({ error: "La propuesta no existe o ya se resolvio" }, { status: 404 });
  return ok();
});
