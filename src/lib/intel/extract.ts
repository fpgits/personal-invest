import { generateObject, NoObjectGeneratedError } from "ai";
import { analysisModel, fastModel } from "@/lib/ai/client";
import { EVENT_PROMPT_VERSION, EVENT_SYSTEM, MERGE_SYSTEM } from "@/lib/ai/prompts";
import { mergePlanSchema, type ExistingEvent, type MergePlan } from "./dedup";
import { sourceTier } from "./sources";
import { eventSchema, type Cluster, type ExtractedEvent } from "./types";

/**
 * Las dos unicas llamadas a IA del motor, ambas via OpenRouter:
 *  - planMerge: modelo barato, una llamada por ejecucion.
 *  - extractEvent: modelo de analisis, una llamada por cluster.
 *
 * Todo lo que devuelve el modelo pasa por Zod y luego por `sanitizeEvent`;
 * una salida que no cumpla el esquema se rechaza, nunca se "arregla" a mano.
 */

export type ExtractContext = {
  /** Activos que la app sigue: cartera, watchlist y posiciones cerradas. */
  tracked: Array<{ symbol: string; name: string; assetClass: string }>;
  positions: Array<{ symbol: string; weight: number; group: string }>;
  watchlist: string[];
  /** Tesis guardada por simbolo, si la hay. */
  theses: Map<string, string>;
};

export type ExtractResult =
  | { ok: true; event: ExtractedEvent; model: string; promptVersion: string }
  | { ok: false; kind: "invalid" | "transient"; message: string };

export async function planMerge(
  clusters: Cluster[],
  existing: ExistingEvent[],
): Promise<MergePlan | null> {
  if (clusters.length < 2 && existing.length === 0) return null;

  const lines = clusters.map((c, i) => {
    const day = new Date(c.occurredAt).toISOString().slice(0, 10);
    const heads = c.items
      .slice(0, 4)
      .map((n) => `"${n.headline}"`)
      .join(" / ");
    return `${i}. [${c.tickers.join(",")}] ${day}: ${heads}`;
  });

  const existingLines = existing.map(
    (e) =>
      `${e.alias}. [${e.companies.join(",")}] ${new Date(e.occurredAt)
        .toISOString()
        .slice(0, 10)}: "${e.headline}"`,
  );

  const prompt = [
    "Grupos:",
    ...lines,
    ...(existingLines.length > 0 ? ["", "Eventos existentes:", ...existingLines] : []),
  ].join("\n");

  try {
    const { object } = await generateObject({
      model: await fastModel(),
      schema: mergePlanSchema,
      system: MERGE_SYSTEM,
      prompt,
      temperature: 0,
    });
    return object;
  } catch (e) {
    // Sin plan no pasa nada: la capa lexica ya hizo lo basico.
    console.warn("[intel] planMerge fallo:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function extractEvent(
  cluster: Cluster,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const prompt = buildExtractPrompt(cluster, ctx);
  let model: Awaited<ReturnType<typeof analysisModel>>;
  try {
    model = await analysisModel();
  } catch (e) {
    return { ok: false, kind: "transient", message: messageOf(e) };
  }

  try {
    const { object } = await generateObject({
      model,
      schema: eventSchema,
      system: EVENT_SYSTEM,
      prompt,
      temperature: 0.1,
    });
    return {
      ok: true,
      event: sanitizeEvent(object, ctx.tracked.map((t) => t.symbol)),
      model: model.modelId,
      promptVersion: EVENT_PROMPT_VERSION,
    };
  } catch (e) {
    // Salida malformada: se rechaza y no se reintenta en bucle. Cualquier
    // otra cosa (red, 429, 5xx) se considera transitoria y se reintentara.
    if (NoObjectGeneratedError.isInstance(e)) {
      return { ok: false, kind: "invalid", message: messageOf(e) };
    }
    return { ok: false, kind: "transient", message: messageOf(e) };
  }
}

export function buildExtractPrompt(cluster: Cluster, ctx: ExtractContext): string {
  const tracked = ctx.tracked
    .map((t) => `${t.symbol.toUpperCase()} (${t.name}, ${t.assetClass})`)
    .join(", ");

  const affected = new Set(cluster.tickers.map((t) => t.toUpperCase()));
  const positionLines = ctx.positions
    .filter((p) => affected.has(p.symbol.toUpperCase()))
    .map((p) => `- ${p.symbol.toUpperCase()}: ${p.weight.toFixed(1)}% de la cartera (${p.group})`);
  const watched = ctx.watchlist.filter((s) => affected.has(s.toUpperCase()));
  const thesisLines = [...affected]
    .filter((s) => ctx.theses.has(s))
    .map((s) => `- ${s}: ${ctx.theses.get(s)!.slice(0, 600)}`);

  const sources = cluster.items.map((n, i) => {
    const tier = sourceTier(n.source, n.url);
    const day = new Date(n.publishedAt).toISOString().slice(0, 10);
    const summary = n.summary ? ` Resumen: ${n.summary}` : "";
    return `[${i + 1}] (${n.source ?? "fuente desconocida"}, tier ${tier}, ${day}) ${n.headline}.${summary}`;
  });

  return [
    `Activos seguidos (usa solo estos simbolos): ${tracked || "ninguno"}`,
    positionLines.length > 0 ? `Posiciones afectadas:\n${positionLines.join("\n")}` : "",
    watched.length > 0 ? `En watchlist: ${watched.join(", ")}` : "",
    thesisLines.length > 0 ? `Tesis guardadas:\n${thesisLines.join("\n")}` : "",
    "",
    `Fuentes del hecho (${sources.length}):`,
    ...sources,
    "",
    "Devuelve el evento estructurado.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Segunda linea de defensa tras Zod. Simbolos fuera de la lista se descartan
 * (el modelo no puede "descubrir" empresas), y si el modelo dice que es ruido
 * los numeros tienen que decir lo mismo.
 */
export function sanitizeEvent(ev: ExtractedEvent, trackedSymbols: string[]): ExtractedEvent {
  const tracked = new Set(trackedSymbols.map((s) => s.toUpperCase()));
  const companies = [...new Set(ev.companies.map((s) => s.trim().toUpperCase()))].filter((s) =>
    tracked.has(s),
  );
  const primary = ev.primary_symbol?.trim().toUpperCase() ?? null;
  const primary_symbol = primary && tracked.has(primary) ? primary : (companies[0] ?? null);
  if (primary_symbol && !companies.includes(primary_symbol)) companies.unshift(primary_symbol);

  const is_noise = ev.is_noise || companies.length === 0;
  return {
    ...ev,
    companies,
    primary_symbol,
    is_noise,
    thesis_impact: is_noise ? 0 : ev.thesis_impact,
    materiality: is_noise ? Math.min(ev.materiality, 20) : ev.materiality,
    headline: ev.headline.trim(),
    fact: ev.fact.trim(),
    inference: ev.inference.trim(),
    assessment: ev.assessment.trim(),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
