import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import {
  generateObject,
  generateText,
  NoObjectGeneratedError,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { gte, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { aiCalls } from "@/db/schema";
import { env } from "@/lib/env";
import { getSetting, resolveModels, SETTING_KEYS } from "@/lib/settings";
import { id } from "@/lib/utils";
import { AiBudgetError, messageOf } from "./errors";
import {
  AI_POLICY,
  budgetState,
  CALL_RETENTION_DAYS,
  dayStartUtc,
  DEFAULT_DAILY_BUDGET_USD,
  parseBudget,
  usageFromResult,
  type AiPurpose,
  type BudgetState,
  type CallUsage,
  type ModelPrices,
} from "./policy";

/**
 * Unica puerta a OpenRouter. Cada llamada declara su proposito y de ahi
 * salen el modelo, el tope de salida, el razonamiento, el timeout y si
 * respeta el presupuesto diario (ver `policy.ts`). Cada llamada, buena o
 * mala, deja una fila en `ai_calls` con tokens y coste.
 */

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

// ---------------------------------------------------------------------------
// Catalogo

export type ModelInfo = {
  id: string;
  name: string;
  contextLength: number;
  /** USD por millon de tokens. */
  promptPrice: number;
  completionPrice: number;
  /** El modelo acepta el parametro `reasoning` (esfuerzo de razonamiento). */
  reasoning: boolean;
};

const CATALOG_TTL_MS = 60 * 60_000;
const CATALOG_RETRY_MS = 5 * 60_000;
let catalogMemo: { at: number; models: ModelInfo[] | null } | null = null;

/**
 * Catalogo en vivo de OpenRouter. El catalogo cambia cada semana, asi que
 * la app lo lee en runtime en vez de tener modelos hardcodeados. Se cachea
 * una hora por instancia: lo usan Ajustes y cada llamada (precio y
 * capacidades del modelo).
 */
export async function listModels(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (catalogMemo?.models && now - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.models;

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
      supported_parameters?: string[];
    }>;
  };

  const models = json.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? 0,
      promptPrice: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      completionPrice: Number(m.pricing?.completion ?? 0) * 1_000_000,
      reasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  catalogMemo = { at: now, models };
  return models;
}

/** Entrada del catalogo para un modelo, o null si no esta o el catalogo no responde. */
async function catalogEntry(modelId: string): Promise<ModelInfo | null> {
  const now = Date.now();
  if (catalogMemo && !catalogMemo.models && now - catalogMemo.at < CATALOG_RETRY_MS) return null;
  try {
    const models = await listModels();
    return models.find((m) => m.id === modelId) ?? null;
  } catch (e) {
    console.warn("[ai] catalogo de OpenRouter no disponible:", messageOf(e));
    catalogMemo = { at: now, models: null };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Modelo por proposito

type Prepared = { model: LanguageModel; modelId: string; prices: ModelPrices | null };

/**
 * Construye el modelo con la politica del proposito:
 *  - contabilidad de uso siempre (tokens y coste reales en la respuesta);
 *  - esfuerzo de razonamiento acotado, solo si el modelo lo admite;
 *  - en trabajo de fondo, el proveedor mas barato que sirve ese modelo.
 */
export async function modelFor(purpose: AiPurpose, tier = AI_POLICY[purpose].tier): Promise<Prepared> {
  const policy = AI_POLICY[purpose];
  const { analysis, fast } = await resolveModels();
  const modelId = tier === "fast" ? fast : analysis;
  const entry = await catalogEntry(modelId);

  const settings: OpenRouterChatSettings = { usage: { include: true } };
  if (policy.reasoning === "none") {
    // Apagarlo explicitamente, sepamos o no del catalogo: un modelo que razona
    // por defecto (DeepSeek) tarda 40s+ en una tarea mecanica. `enabled:false`
    // via extraBody porque el tipo de `reasoning` exige effort/max_tokens.
    settings.extraBody = { ...(settings.extraBody ?? {}), reasoning: { enabled: false } };
  } else if (policy.reasoning && entry?.reasoning) {
    settings.reasoning = { effort: policy.reasoning, exclude: true };
  }
  if (policy.background) settings.provider = { sort: "price" };

  return {
    model: openrouter().chat(modelId, settings),
    modelId,
    prices: entry ? { promptPrice: entry.promptPrice, completionPrice: entry.completionPrice } : null,
  };
}

// ---------------------------------------------------------------------------
// Presupuesto diario

const BUDGET_TTL_MS = 60_000;
let budgetMemo: { at: number; value: { limitUsd: number; source: BudgetSource } } | null = null;

export type BudgetSource = "settings" | "env" | "default";

export async function dailyBudget(): Promise<{ limitUsd: number; source: BudgetSource }> {
  if (budgetMemo && Date.now() - budgetMemo.at < BUDGET_TTL_MS) return budgetMemo.value;
  const stored = await getSetting(SETTING_KEYS.aiDailyBudget).catch(() => null);
  let value: { limitUsd: number; source: BudgetSource };
  if (stored !== null && stored.trim() !== "") {
    value = { limitUsd: parseBudget(stored, DEFAULT_DAILY_BUDGET_USD), source: "settings" };
  } else if (env.aiDailyBudgetUsd) {
    value = { limitUsd: parseBudget(env.aiDailyBudgetUsd, DEFAULT_DAILY_BUDGET_USD), source: "env" };
  } else {
    value = { limitUsd: DEFAULT_DAILY_BUDGET_USD, source: "default" };
  }
  budgetMemo = { at: Date.now(), value };
  return value;
}

/** Guardar el presupuesto en Ajustes debe verse al momento, no un minuto despues. */
export function invalidateBudget() {
  budgetMemo = null;
}

export async function spentSince(sinceMs: number): Promise<{ cost: number; calls: number }> {
  const rows = await db
    .select({
      cost: sql<number>`coalesce(sum(${aiCalls.cost}), 0)`,
      calls: sql<number>`count(*)`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, sinceMs));
  return { cost: Number(rows[0]?.cost ?? 0), calls: Number(rows[0]?.calls ?? 0) };
}

export type BudgetStatus = BudgetState & { source: BudgetSource; todayCalls: number };

export async function budgetStatus(now = Date.now()): Promise<BudgetStatus> {
  const [{ limitUsd, source }, today] = await Promise.all([dailyBudget(), spentSince(dayStartUtc(now))]);
  return { ...budgetState(limitUsd, today.cost), source, todayCalls: today.calls };
}

/**
 * Solo el trabajo de fondo respeta el presupuesto: una pasada del cron que
 * se pasa de la raya se para y sigue manana. Si la base de datos no
 * responde, no se bloquea (fallar cerrado aqui dejaria el motor mudo por
 * un problema que no es de dinero).
 */
async function assertBudget(purpose: AiPurpose): Promise<void> {
  if (!AI_POLICY[purpose].background) return;
  let status: BudgetStatus;
  try {
    status = await budgetStatus();
  } catch (e) {
    console.warn("[ai] no se pudo leer el presupuesto:", messageOf(e));
    return;
  }
  if (status.blocked) throw new AiBudgetError(status);
}

// ---------------------------------------------------------------------------
// Registro

let pruned = false;

async function recordCall(row: {
  purpose: AiPurpose;
  model: string;
  startedAt: number;
  ok: boolean;
  error?: string;
  usage?: CallUsage;
}): Promise<void> {
  const u = row.usage;
  try {
    await db.insert(aiCalls).values({
      id: id(),
      purpose: row.purpose,
      model: row.model,
      promptTokens: u?.promptTokens ?? 0,
      completionTokens: u?.completionTokens ?? 0,
      reasoningTokens: u?.reasoningTokens ?? 0,
      cachedTokens: u?.cachedTokens ?? 0,
      cost: u?.cost ?? 0,
      costSource: u?.costSource ?? "none",
      ms: Math.max(0, Date.now() - row.startedAt),
      ok: row.ok,
      error: row.error ? row.error.slice(0, 400) : null,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.warn("[ai] no se pudo registrar la llamada:", messageOf(e));
    return;
  }
  if (!pruned) {
    pruned = true;
    await db
      .delete(aiCalls)
      .where(lt(aiCalls.createdAt, Date.now() - CALL_RETENTION_DAYS * 86400_000))
      .catch(() => undefined);
  }
}

/** Un fallo del modelo tambien ha gastado tokens (p. ej. un JSON invalido). */
function usageOfError(e: unknown, prices: ModelPrices | null): CallUsage | undefined {
  if (NoObjectGeneratedError.isInstance(e) && e.usage) {
    return usageFromResult({ usage: e.usage, prices });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Llamadas

export type AiObjectArgs<T> = {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  temperature?: number;
  /** Cambia el modelo (rapido/analisis) sin cambiar el proposito; para reintentos. */
  tier?: "fast" | "analysis";
};

export type AiObjectResult<T> = { object: T; modelId: string; usage: CallUsage };

/** Salida estructurada (Zod). Lanza `AiBudgetError` antes de gastar si toca esperar. */
export async function aiObject<T>(purpose: AiPurpose, args: AiObjectArgs<T>): Promise<AiObjectResult<T>> {
  const startedAt = Date.now();
  await assertBudget(purpose);
  const { model, modelId, prices } = await modelFor(purpose, args.tier);
  const policy = AI_POLICY[purpose];
  try {
    const res = await generateObject({
      model,
      schema: args.schema,
      system: args.system,
      prompt: args.prompt,
      temperature: args.temperature,
      maxOutputTokens: policy.maxOutputTokens,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(policy.timeoutMs),
    });
    const usage = usageFromResult({ usage: res.usage, providerMetadata: res.providerMetadata, prices });
    await recordCall({ purpose, model: modelId, startedAt, ok: true, usage });
    return { object: res.object as T, modelId, usage };
  } catch (e) {
    await recordCall({ purpose, model: modelId, startedAt, ok: false, error: messageOf(e), usage: usageOfError(e, prices) });
    throw e;
  }
}

export type AiTextArgs = {
  system: string;
  prompt: string;
  temperature?: number;
};

export type AiTextResult = { text: string; modelId: string; usage: CallUsage };

/** Texto libre (riesgo, tesis en prosa). */
export async function aiText(purpose: AiPurpose, args: AiTextArgs): Promise<AiTextResult> {
  const startedAt = Date.now();
  await assertBudget(purpose);
  const { model, modelId, prices } = await modelFor(purpose);
  const policy = AI_POLICY[purpose];
  try {
    const res = await generateText({
      model,
      system: args.system,
      prompt: args.prompt,
      temperature: args.temperature,
      maxOutputTokens: policy.maxOutputTokens,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(policy.timeoutMs),
    });
    const usage = usageFromResult({ usage: res.usage, providerMetadata: res.providerMetadata, prices });
    await recordCall({ purpose, model: modelId, startedAt, ok: true, usage });
    return { text: res.text, modelId, usage };
  } catch (e) {
    await recordCall({ purpose, model: modelId, startedAt, ok: false, error: messageOf(e) });
    throw e;
  }
}

export type AiStreamArgs = {
  messages: ModelMessage[];
  temperature?: number;
  /** Con el texto completo, cuando el modelo termina (aunque el cliente se haya ido). */
  onFinish?: (text: string, usage: CallUsage) => Promise<void> | void;
};

/** Chat en streaming. El registro se hace al terminar el stream. */
export async function aiStream(purpose: AiPurpose, args: AiStreamArgs) {
  const startedAt = Date.now();
  const { model, modelId, prices } = await modelFor(purpose);
  const policy = AI_POLICY[purpose];
  let recorded = false;
  const result = streamText({
    model,
    messages: args.messages,
    temperature: args.temperature,
    maxOutputTokens: policy.maxOutputTokens,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(policy.timeoutMs),
    onFinish: async (ev) => {
      recorded = true;
      const usage = usageFromResult({ usage: ev.usage, providerMetadata: ev.providerMetadata, prices });
      await recordCall({ purpose, model: modelId, startedAt, ok: true, usage });
      await args.onFinish?.(ev.text, usage);
    },
    onError: ({ error }) => {
      if (recorded) return;
      recorded = true;
      void recordCall({ purpose, model: modelId, startedAt, ok: false, error: messageOf(error) });
    },
    onAbort: () => {
      if (recorded) return;
      recorded = true;
      void recordCall({ purpose, model: modelId, startedAt, ok: false, error: "Respuesta cortada por tiempo" });
    },
  });
  return { result, modelId };
}
