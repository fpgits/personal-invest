import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "@/lib/env";
import { resolveModels } from "@/lib/settings";

let cached: ReturnType<typeof createOpenRouter> | null = null;

export function openrouter() {
  if (!cached) {
    cached = createOpenRouter({
      apiKey: env.openrouterKey,
      headers: {
        "HTTP-Referer": env.siteUrl,
        "X-Title": env.siteName,
      },
    });
  }
  return cached;
}

/** Modelo bueno para razonar sobre la cartera. */
export async function analysisModel() {
  const { analysis } = await resolveModels();
  return openrouter()(analysis);
}

/** Modelo barato para resumir noticias en volumen. */
export async function fastModel() {
  const { fast } = await resolveModels();
  return openrouter()(fast);
}

export type ModelInfo = {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
};

/**
 * Catalogo en vivo de OpenRouter. El catalogo cambia cada semana, asi que
 * la app lo lee en runtime en vez de tener modelos hardcodeados.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${env.openrouterKey}` },
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`OpenRouter respondio ${res.status}`);

  const json = (await res.json()) as {
    data: Array<{
      id: string;
      name: string;
      context_length: number;
      pricing: { prompt: string; completion: string };
    }>;
  };

  return json.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? 0,
      promptPrice: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      completionPrice: Number(m.pricing?.completion ?? 0) * 1_000_000,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
