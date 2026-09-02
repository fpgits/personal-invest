import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import { ensureAsset } from "@/lib/assets";
import { fundamentalsToText } from "@/lib/fundamentals";
import {
  ASSUMPTION_STATUSES,
  generateThesisDraft,
  listTheses,
  saveThesis,
  setConviction,
  thesisStructureSchema,
  updateAssumptions,
} from "@/lib/thesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const assetRef = z.object({
  symbol: z.string().min(1).max(20),
  assetClass: z.enum(["equity", "etf", "crypto"]),
});

/** Todas las tesis con supuestos, propuestas pendientes, historial y fundamentales. */
export const GET = protectedRoute(async () => {
  const views = await listTheses();
  return Response.json({
    theses: views.map((v) => ({ ...v, fundamentalsText: fundamentalsToText(v.fundamentals) })),
  });
});

/** Genera un borrador estructurado con IA. No lo guarda: eso lo decide el usuario. */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, assetRef);
  const asset = await ensureAsset({ symbol: body.symbol, assetClass: body.assetClass });
  const draft = await generateThesisDraft(asset);
  return Response.json({ asset, ...draft });
});

const saveSchema = assetRef.extend({
  structure: thesisStructureSchema,
  conviction: z.number().int().min(1).max(5).optional(),
  horizon: z.string().max(60).optional(),
  targetPrice: z.number().positive().optional(),
  generatedBy: z.string().max(120).default("manual"),
  promptVersion: z.string().max(40).optional(),
});

/** Guarda o actualiza la tesis estructurada de un activo. */
export const PUT = protectedRoute(async (req) => {
  const body = await parseBody(req, saveSchema);
  const asset = await ensureAsset({ symbol: body.symbol, assetClass: body.assetClass });
  const thesisId = await saveThesis({
    assetId: asset.id,
    structure: body.structure,
    conviction: body.conviction ?? null,
    horizon: body.horizon ?? null,
    targetPrice: body.targetPrice ?? null,
    generatedBy: body.generatedBy,
    promptVersion: body.promptVersion,
  });
  return ok({ thesisId });
});

const patchSchema = z.object({
  thesisId: z.string().min(1).max(64),
  conviction: z.number().int().min(1).max(5).optional(),
  assumptions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        status: z.enum(ASSUMPTION_STATUSES),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
});

/** Cambios a mano: estado de supuestos y conviccion. */
export const PATCH = protectedRoute(async (req) => {
  const body = await parseBody(req, patchSchema);
  let updated = 0;
  if (body.assumptions?.length) updated = await updateAssumptions(body.thesisId, body.assumptions);
  if (body.conviction !== undefined) await setConviction(body.thesisId, body.conviction);
  return ok({ updated });
});
