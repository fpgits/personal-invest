import { z } from "zod";
import { ok, parseBody, protectedRoute } from "@/lib/api";
import {
  addManager,
  listManagers,
  managerById,
  removeManager,
  setManagerEnabled,
  syncManager,
} from "@/lib/managers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** El alta descarga los dos ultimos 13F del gestor: puede tardar un minuto. */
export const maxDuration = 300;

/** Gestores seguidos con su ultimo 13F, cambios y top de posiciones. */
export const GET = protectedRoute(async () => {
  return Response.json({ managers: await listManagers() });
});

const addSchema = z.object({
  cik: z.string().min(1).max(20),
  note: z.string().max(300).optional(),
});

/**
 * Alta por CIK. Se valida contra EDGAR (nombre oficial y que presente 13F-HR)
 * y acto seguido se descargan sus dos ultimos 13F para tener ya un diff.
 */
export const POST = protectedRoute(async (req) => {
  const body = await parseBody(req, addSchema);
  const manager = await addManager(body.cik, {}, body.note);
  const sync = await syncManager(manager, {}, { deadline: Date.now() + 240_000 });
  return Response.json({ manager: await managerById(manager.id), sync });
});

const patchSchema = z.object({
  id: z.string().min(1).max(64),
  enabled: z.boolean(),
});

/** Pausar o reanudar un gestor sin perder su historial. */
export const PATCH = protectedRoute(async (req) => {
  const body = await parseBody(req, patchSchema);
  if (!(await managerById(body.id))) {
    return Response.json({ error: "Ese gestor no existe" }, { status: 404 });
  }
  await setManagerEnabled(body.id, body.enabled);
  return ok();
});

/** Borra el gestor con sus filings y posiciones. Los eventos ya creados se quedan. */
export const DELETE = protectedRoute(async (req) => {
  const managerId = new URL(req.url).searchParams.get("id");
  if (!managerId) return Response.json({ error: "Falta id" }, { status: 400 });
  await removeManager(managerId);
  return ok();
});
