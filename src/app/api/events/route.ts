import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import {
  FEEDBACK_VALUES,
  PRIORITIES,
  lastRun,
  processEvents,
  recentEvents,
  setEventFeedback,
} from "@/lib/intel";
import { periodBounds } from "@/lib/period";
import { pendingProposalsByEvent } from "@/lib/thesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  min: z.enum(PRIORITIES).default("P4"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Periodo de revision (dias, ambos incluidos) por fecha del hecho. */
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Grupo del activo principal: bolsa/cripto filtran; all no. */
  group: z.enum(["all", "bolsa", "cripto"]).default("all"),
});

/** Feed de eventos y resultado de la ultima pasada (cron o manual). */
export const GET = protectedRoute(async (req) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return Response.json(
      { error: "Parametros invalidos", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { from, to } = parsed.data;
  const window = from && to ? periodBounds({ from, to }) : {};
  const [events, run] = await Promise.all([
    recentEvents({ minPriority: parsed.data.min, limit: parsed.data.limit, group: parsed.data.group, ...window }),
    lastRun(),
  ]);
  const proposals = await pendingProposalsByEvent(events.map((e) => e.id));
  return Response.json({
    events: events.map((e) => ({ ...e, proposalId: proposals.get(e.id) ?? null })),
    lastRun: run,
  });
});

/** Ejecucion manual del motor desde la UI. Una pasada a la vez. */
export const POST = protectedRoute(async () => {
  const stats = await processEvents({ trigger: "manual" });
  if (stats.locked) {
    return Response.json(
      { error: "Ya hay una pasada en marcha; espera a que termine.", stats },
      { status: 409 },
    );
  }
  return Response.json({ stats, events: await recentEvents({ minPriority: "P4" }) });
});

const feedbackSchema = z.object({
  id: z.string().min(1).max(64),
  feedback: z.enum(FEEDBACK_VALUES).nullable(),
});

/** Feedback sobre un evento: es lo que luego recalibra los pesos del score. */
export const PATCH = protectedRoute(async (req) => {
  const body = await parseBody(req, feedbackSchema);
  await setEventFeedback(body.id, body.feedback);
  return ok();
});
