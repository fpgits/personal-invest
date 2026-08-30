import { listModels } from "@/lib/ai/client";
import { protectedRoute } from "@/lib/api";
import { resolveModels } from "@/lib/settings";

export const runtime = "nodejs";

export const GET = protectedRoute(async () => {
  const current = await resolveModels();
  try {
    return Response.json({ models: await listModels(), current });
  } catch (e) {
    // Si OpenRouter no responde, la pagina de ajustes sigue siendo util.
    return Response.json({
      models: [],
      current,
      error: (e as Error).message,
    });
  }
});
