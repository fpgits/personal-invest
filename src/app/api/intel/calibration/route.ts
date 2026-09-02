import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { calibrationReport, normalizeWeights, saveWeights, suggestWeights } from "@/lib/intel";
import { ratedRows } from "@/lib/intel/calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Informe de calibracion: precision por prioridad, pesos actuales y sugerencia. */
export const GET = protectedRoute(async () => Response.json(await calibrationReport()));

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suggest") }),
  z.object({ action: z.literal("reset") }),
  z.object({
    action: z.literal("set"),
    weights: z.record(z.string(), z.number()),
  }),
]);

/**
 * suggest: aplica los pesos sugeridos por el feedback (si hay muestras).
 * set: pesos a mano (se normalizan a suma 1). reset: vuelve a los de codigo.
 */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, schema);
  if (body.action === "reset") {
    await saveWeights(null);
  } else if (body.action === "set") {
    const w = normalizeWeights(body.weights);
    if (!w) return Response.json({ error: "Pesos invalidos" }, { status: 400 });
    await saveWeights(w);
  } else {
    const { rows } = await ratedRows();
    const s = suggestWeights(rows);
    if (!s.weights) return Response.json({ error: s.note }, { status: 400 });
    await saveWeights(s.weights);
  }
  return ok(await calibrationReport());
});
