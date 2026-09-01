import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import {
  FEEDBACK_VALUES,
  PRIORITIES,
  processEvents,
  recentEvents,
  setEventFeedback,
} from "@/lib/intel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Feed de eventos. `min` = prioridad minima (P1..P5), por defecto P4. */
export const GET = protectedRoute(async (req) => {
  const params = new URL(req.url).searchParams;
  const min = params.get("min");
  const minPriority = PRIORITIES.find((p) => p === min) ?? "P4";
  const limit = Number(params.get("limit") ?? 50);
  return Response.json({
    events: await recentEvents({ minPriority, limit: Math.min(limit, 200) }),
  });
});

/** Ejecucion manual del motor desde la UI. */
export const POST = protectedRoute(async () => {
  const stats = await processEvents();
  return Response.json({ stats, events: await recentEvents({ minPriority: "P4" }) });
});

const feedbackSchema = z.object({
  id: z.string().min(1),
  feedback: z.enum(FEEDBACK_VALUES).nullable(),
});

/** Feedback sobre un evento: es lo que luego recalibra los pesos del score. */
export const PATCH = protectedRoute(async (req) => {
  const body = await parseBody(req, feedbackSchema);
  await setEventFeedback(body.id, body.feedback);
  return ok();
});
