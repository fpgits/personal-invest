import { listModels } from "@/lib/ai/client";
import { protectedRoute } from "@/lib/api";
import { resolveModels } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Catalogo en vivo mas una comprobacion: si el id configurado no existe en
 * OpenRouter, el resumen de noticias y el motor de eventos fallan en silencio
 * hasta que alguien mira los logs. Mejor decirlo aqui.
 */
export const GET = protectedRoute(async () => {
  const current = await resolveModels();
  try {
    const models = await listModels();
    const ids = new Set(models.map((m) => m.id));
    return Response.json({
      models,
      current,
      check: {
        analysis: ids.has(current.analysis),
        fast: ids.has(current.fast),
      },
    });
  } catch (e) {
    // Si OpenRouter no responde, la pagina de ajustes sigue siendo util.
    return Response.json({
      models: [],
      current,
      check: null,
      error: (e as Error).message,
    });
  }
});
