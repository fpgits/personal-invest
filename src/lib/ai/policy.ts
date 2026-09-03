/**
 * Politica de uso de OpenRouter, en un sitio y sin red ni base de datos:
 * que modelo usa cada tipo de llamada, cuanta salida puede producir, cuanto
 * razonamiento se le pide, cuanto tiempo se le da y si entra en el
 * presupuesto diario. Todo lo que gasta dinero pasa por aqui, asi que
 * cambiar el gasto de la app es cambiar esta tabla.
 *
 * Tambien viven aqui las funciones puras que usan la contabilidad y el
 * panel de uso (parseo de la contabilidad de OpenRouter, presupuesto,
 * agregados), para poder testearlas sin Turso.
 */

export const AI_PURPOSES = [
  "news_summary",
  "merge",
  "extract",
  "thesis_check",
  "thesis_draft",
  "thesis_text",
  "risk",
  "chat",
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/** Esfuerzo de razonamiento que se pide a OpenRouter (se ignora si el modelo no razona). */
export type ReasoningEffort = "low" | "medium" | "high";

export type PurposePolicy = {
  label: string;
  /** fast: el modelo barato de Ajustes; analysis: el de analisis. */
  tier: "fast" | "analysis";
  /**
   * Tope de tokens de salida. En los modelos que razonan, el razonamiento
   * cuenta dentro de este tope (OpenRouter reserva ~20% con `low` y ~50% con
   * `medium`), asi que deja margen: un JSON de evento son ~800-1400 tokens.
   */
  maxOutputTokens: number;
  timeoutMs: number;
  /** Sin valor: el modelo decide (llamadas interactivas, donde prima la calidad). */
  reasoning?: ReasoningEffort;
  /**
   * Trabajo de fondo (crons). Se enruta al proveedor mas barato del modelo
   * y se detiene cuando el presupuesto diario se agota. Lo que pide el
   * usuario a mano nunca se bloquea por presupuesto.
   */
  background: boolean;
};

export const AI_POLICY: Record<AiPurpose, PurposePolicy> = {
  news_summary: {
    label: "Resumen de noticias",
    tier: "fast",
    maxOutputTokens: 2000,
    timeoutMs: 45_000,
    reasoning: "low",
    background: true,
  },
  merge: {
    label: "Agrupacion de noticias",
    tier: "fast",
    maxOutputTokens: 800,
    timeoutMs: 30_000,
    reasoning: "low",
    background: true,
  },
  extract: {
    label: "Extraccion de eventos",
    tier: "analysis",
    maxOutputTokens: 2500,
    timeoutMs: 75_000,
    reasoning: "medium",
    background: true,
  },
  thesis_check: {
    label: "Contraste con la tesis",
    tier: "analysis",
    maxOutputTokens: 2000,
    timeoutMs: 60_000,
    reasoning: "medium",
    background: true,
  },
  thesis_draft: {
    label: "Borrador de tesis",
    tier: "analysis",
    maxOutputTokens: 4000,
    timeoutMs: 90_000,
    background: false,
  },
  thesis_text: {
    label: "Tesis en texto",
    tier: "analysis",
    maxOutputTokens: 2500,
    timeoutMs: 90_000,
    background: false,
  },
  risk: {
    label: "Analisis de riesgo",
    tier: "analysis",
    maxOutputTokens: 2500,
    timeoutMs: 90_000,
    background: false,
  },
  chat: {
    label: "Chat",
    tier: "analysis",
    maxOutputTokens: 3000,
    timeoutMs: 100_000,
    background: false,
  },
};

/** Limites del contexto del chat: lo que no cabe se recorta, no se manda. */
export const CHAT_LIMITS = {
  /** Mensajes de historial que se leen del hilo. */
  historyMessages: 20,
  /** Caracteres totales de historial que entran en el prompt. */
  historyChars: 16_000,
  /** Caracteres por mensaje de historial. */
  messageChars: 3_000,
  /** Vida del contexto de cartera/tesis/noticias entre mensajes, en ms. */
  contextTtlMs: 10 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Presupuesto diario

export const DEFAULT_DAILY_BUDGET_USD = 2;
export const BUDGET_SETTING_KEY = "ai_daily_budget_usd";
/** Dias que se conserva el registro de llamadas. */
export const CALL_RETENTION_DAYS = 90;

/** Presupuesto en USD; 0 significa sin limite. Cualquier cosa rara → fallback. */
export function parseBudget(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export type BudgetState = {
  /** 0 = sin limite. */
  limitUsd: number;
  spentUsd: number;
  /** null = sin limite. */
  remainingUsd: number | null;
  /** true cuando las llamadas de fondo deben esperar a manana. */
  blocked: boolean;
};

export function budgetState(limitUsd: number, spentUsd: number): BudgetState {
  const limit = Number.isFinite(limitUsd) && limitUsd > 0 ? limitUsd : 0;
  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  if (limit === 0) return { limitUsd: 0, spentUsd: spent, remainingUsd: null, blocked: false };
  return {
    limitUsd: limit,
    spentUsd: spent,
    remainingUsd: Math.max(0, limit - spent),
    blocked: spent >= limit,
  };
}

/** Inicio del dia UTC: el presupuesto es "por dia de calendario" y no depende de la zona del servidor. */
export function dayStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------
// Contabilidad de una llamada

export type CostSource = "openrouter" | "estimate" | "none";

export type CallUsage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** USD. */
  cost: number;
  costSource: CostSource;
};

export type ModelPrices = {
  /** USD por millon de tokens de entrada. */
  promptPrice: number;
  /** USD por millon de tokens de salida. */
  completionPrice: number;
};

/** Forma minima de `usage` del AI SDK v7 (todo opcional: un fallo puede venir sin nada). */
export type SdkUsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
};

/**
 * Convierte lo que devuelve una llamada en una fila de contabilidad. Manda
 * la contabilidad de OpenRouter (`providerMetadata.openrouter.usage`), que
 * trae el coste real; si falta, los tokens del SDK con el precio del
 * catalogo; si tampoco hay precio, coste 0 marcado como desconocido.
 */
export function usageFromResult(input: {
  usage?: SdkUsageLike | null;
  providerMetadata?: unknown;
  prices?: ModelPrices | null;
}): CallUsage {
  const or = openrouterUsage(input.providerMetadata);
  const sdk = input.usage ?? {};

  const promptTokens = int(or?.promptTokens ?? sdk.inputTokens);
  const completionTokens = int(or?.completionTokens ?? sdk.outputTokens);
  const reasoningTokens = int(
    or?.completionTokensDetails?.reasoningTokens ?? sdk.outputTokenDetails?.reasoningTokens,
  );
  const cachedTokens = int(or?.promptTokensDetails?.cachedTokens ?? sdk.inputTokenDetails?.cacheReadTokens);

  if (typeof or?.cost === "number" && Number.isFinite(or.cost)) {
    // Con clave propia del proveedor (BYOK) OpenRouter cobra su comision en
    // `cost` y lo del proveedor va aparte: lo que pagas es la suma.
    const upstream = or.costDetails?.upstreamInferenceCost;
    const total = or.cost + (typeof upstream === "number" && Number.isFinite(upstream) ? upstream : 0);
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      cost: Math.max(0, total),
      costSource: "openrouter",
    };
  }

  const p = input.prices;
  if (p && Number.isFinite(p.promptPrice) && Number.isFinite(p.completionPrice) && (promptTokens > 0 || completionTokens > 0)) {
    const cost = (promptTokens * p.promptPrice + completionTokens * p.completionPrice) / 1_000_000;
    return { promptTokens, completionTokens, reasoningTokens, cachedTokens, cost, costSource: "estimate" };
  }

  return { promptTokens, completionTokens, reasoningTokens, cachedTokens, cost: 0, costSource: "none" };
}

type OpenRouterUsageLike = {
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  costDetails?: { upstreamInferenceCost?: number };
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
};

function openrouterUsage(meta: unknown): OpenRouterUsageLike | null {
  if (!meta || typeof meta !== "object") return null;
  const or = (meta as Record<string, unknown>).openrouter;
  if (!or || typeof or !== "object") return null;
  const usage = (or as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  return usage as OpenRouterUsageLike;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// ---------------------------------------------------------------------------
// Historial del chat

export type HistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Recorta el historial por detras: se conservan los mensajes mas recientes
 * que quepan en `maxChars`, cada uno acotado a `perMessage`. Entra y sale
 * del mas antiguo al mas nuevo.
 */
export function trimHistory<T extends HistoryMessage>(
  history: T[],
  limits: { maxChars: number; perMessage: number } = {
    maxChars: CHAT_LIMITS.historyChars,
    perMessage: CHAT_LIMITS.messageChars,
  },
): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const content =
      m.content.length > limits.perMessage
        ? `${m.content.slice(0, limits.perMessage - 1).trimEnd()}…`
        : m.content;
    if (used + content.length > limits.maxChars) break;
    used += content.length;
    out.push(content === m.content ? m : { ...m, content });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Agregados para el panel

export type UsageBucket = {
  calls: number;
  failed: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** Llamadas correctas cuyo coste no se pudo saber ni estimar. */
  unknownCost: number;
};

export type CallRowLike = {
  purpose: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cost: number;
  costSource: string;
  ms: number;
  ok: boolean;
  error: string | null;
  createdAt: number;
};

export type PurposeUsage = UsageBucket & { purpose: string; label: string; avgMs: number };

export type UsageReport = {
  today: UsageBucket;
  week: UsageBucket;
  month: UsageBucket;
  /** Ultimos 30 dias por tipo de llamada, de mas caro a mas barato. */
  byPurpose: PurposeUsage[];
  /** Ultimos fallos, el mas reciente primero. */
  lastErrors: Array<{ purpose: string; model: string; error: string; at: number }>;
};

/** Respuesta de GET /api/ai/usage. */
export type AiUsageResponse = UsageReport & {
  budget: BudgetState & { source: "settings" | "env" | "default"; todayCalls: number };
  models: { analysis: string; fast: string };
  policy: Record<AiPurpose, PurposePolicy>;
};

function emptyBucket(): UsageBucket {
  return { calls: 0, failed: 0, cost: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, unknownCost: 0 };
}

function add(b: UsageBucket, r: CallRowLike) {
  b.calls++;
  if (!r.ok) b.failed++;
  b.cost += r.cost;
  b.promptTokens += r.promptTokens;
  b.completionTokens += r.completionTokens;
  b.reasoningTokens += r.reasoningTokens;
  b.cachedTokens += r.cachedTokens;
  if (r.ok && r.costSource === "none") b.unknownCost++;
}

/** Agrega las filas de los ultimos 30 dias. Puro. */
export function summarizeCalls(rows: CallRowLike[], now: number): UsageReport {
  const today = emptyBucket();
  const week = emptyBucket();
  const month = emptyBucket();
  const dayStart = dayStartUtc(now);
  const weekStart = now - 7 * 86400_000;
  const monthStart = now - 30 * 86400_000;

  const byPurpose = new Map<string, PurposeUsage & { totalMs: number }>();
  const errors: UsageReport["lastErrors"] = [];

  for (const r of rows) {
    if (r.createdAt < monthStart) continue;
    add(month, r);
    if (r.createdAt >= weekStart) add(week, r);
    if (r.createdAt >= dayStart) add(today, r);

    const label = AI_POLICY[r.purpose as AiPurpose]?.label ?? r.purpose;
    const p = byPurpose.get(r.purpose) ?? { ...emptyBucket(), purpose: r.purpose, label, avgMs: 0, totalMs: 0 };
    add(p, r);
    if (r.ok) p.totalMs += r.ms;
    byPurpose.set(r.purpose, p);

    if (!r.ok && r.error) errors.push({ purpose: r.purpose, model: r.model, error: r.error, at: r.createdAt });
  }

  const purposes = [...byPurpose.values()]
    .map(({ totalMs, ...p }) => ({ ...p, avgMs: p.calls - p.failed > 0 ? Math.round(totalMs / (p.calls - p.failed)) : 0 }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls);

  errors.sort((a, b) => b.at - a.at);

  return { today, week, month, byPurpose: purposes, lastErrors: errors.slice(0, 5) };
}
