import { z } from "zod";
import { parseBody, protectedRoute } from "@/lib/api";
import { runMonthlyPlan } from "@/lib/conviction-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  equityCash: z.number().min(0).max(10_000_000).nullable().optional(),
  cryptoCash: z.number().min(0).max(10_000_000).nullable().optional(),
  /** true = registrar el plan como llamada del mes para medirlo despues. */
  save: z.boolean().optional(),
});

/**
 * Plan mensual del oraculo: a donde va el efectivo de bolsa (por conviccion y
 * margen de seguridad, con tope por posicion y reserva) y el de cripto (nucleo
 * por ciclo). Determinista, de solo lectura: propone, no opera.
 */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, schema);
  const plan = await runMonthlyPlan({
    equityCash: body.equityCash ?? null,
    cryptoCash: body.cryptoCash ?? null,
    save: body.save ?? false,
  });
  return Response.json({
    equity: plan.equity,
    crypto: plan.crypto,
    settings: plan.settings,
    batchId: plan.batchId,
    asOf: plan.run.asOf,
    currency: plan.run.currency,
    riskFree: plan.run.riskFree,
    results: plan.run.results,
  });
});
