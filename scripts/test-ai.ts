/**
 * Tests de la politica de IA (puro, sin red ni base de datos): topes por
 * proposito, presupuesto, parseo de la contabilidad de OpenRouter, recorte
 * del historial del chat y agregados del panel de uso.
 * Correr con: npm run test:ai
 */
import { AiBudgetError, classifyError, isBudgetError } from "../src/lib/ai/errors";
import {
  AI_POLICY,
  AI_PURPOSES,
  budgetState,
  CHAT_LIMITS,
  dayStartUtc,
  parseBudget,
  summarizeCalls,
  trimHistory,
  usageFromResult,
  type CallRowLike,
} from "../src/lib/ai/policy";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function near(actual: number, expected: number, label: string, tol = 1e-9) {
  checks++;
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n# Politica por proposito");
{
  for (const p of AI_PURPOSES) {
    const pol = AI_POLICY[p];
    truthy(pol && pol.maxOutputTokens >= 800, `${p}: tope de salida razonable (${pol?.maxOutputTokens})`);
    truthy(pol.timeoutMs >= 30_000 && pol.timeoutMs <= 100_000, `${p}: timeout entre 30 y 100 s`);
  }
  const background = AI_PURPOSES.filter((p) => AI_POLICY[p].background);
  eq(background, ["news_summary", "merge", "extract", "thesis_check"], "solo las tareas de cron respetan presupuesto");
  // Tareas mecanicas: razonamiento apagado (si no, DeepSeek se va a 40s+).
  eq(AI_POLICY.news_summary.reasoning, "none", "el resumen de noticias no razona");
  eq(AI_POLICY.merge.reasoning, "none", "la agrupacion no razona");
  // Donde aporta, razonamiento acotado a medium.
  eq(AI_POLICY.extract.reasoning, "medium", "la extraccion razona (medium)");
  eq(AI_POLICY.thesis_check.reasoning, "medium", "el contraste de tesis razona (medium)");
  truthy(
    AI_PURPOSES.filter((p) => !AI_POLICY[p].background).every((p) => !AI_POLICY[p].reasoning),
    "las llamadas interactivas dejan el razonamiento al modelo",
  );
  eq(AI_POLICY.news_summary.tier, "fast", "resumen de noticias con el modelo rapido");
  eq(AI_POLICY.merge.tier, "fast", "agrupacion con el modelo rapido");
  eq(AI_POLICY.extract.tier, "analysis", "extraccion con el de analisis");
  truthy(AI_POLICY.extract.maxOutputTokens >= 2000, "un evento (hasta ~1400 tokens) cabe con razonamiento medio");
  truthy(AI_POLICY.chat.maxOutputTokens <= 4000, "el chat no puede escribir sin fin");
  eq(CHAT_LIMITS.historyMessages, 20, "20 mensajes de historial");
}

// ---------------------------------------------------------------------------
console.log("\n# Presupuesto");
{
  eq(parseBudget(null, 2), 2, "sin valor → fallback");
  eq(parseBudget("", 2), 2, "vacio → fallback");
  eq(parseBudget("  ", 2), 2, "espacios → fallback");
  eq(parseBudget("abc", 2), 2, "texto → fallback");
  eq(parseBudget("-1", 2), 2, "negativo → fallback");
  eq(parseBudget("0", 2), 0, "0 se respeta (sin limite)");
  eq(parseBudget("2.5", 2), 2.5, "decimal");
  eq(parseBudget(" 10 ", 2), 10, "con espacios alrededor");

  eq(budgetState(2, 0.5), { limitUsd: 2, spentUsd: 0.5, remainingUsd: 1.5, blocked: false }, "por debajo del limite");
  eq(budgetState(2, 2), { limitUsd: 2, spentUsd: 2, remainingUsd: 0, blocked: true }, "justo en el limite bloquea");
  eq(budgetState(2, 3), { limitUsd: 2, spentUsd: 3, remainingUsd: 0, blocked: true }, "pasado el limite bloquea");
  eq(budgetState(0, 99), { limitUsd: 0, spentUsd: 99, remainingUsd: null, blocked: false }, "0 = sin limite");
  eq(budgetState(NaN, NaN), { limitUsd: 0, spentUsd: 0, remainingUsd: null, blocked: false }, "NaN no rompe nada");
  eq(budgetState(2, -1), { limitUsd: 2, spentUsd: 0, remainingUsd: 2, blocked: false }, "gasto negativo se ignora");

  eq(dayStartUtc(Date.UTC(2026, 8, 2, 23, 59, 59)), Date.UTC(2026, 8, 2), "inicio del dia UTC");
  eq(dayStartUtc(Date.UTC(2026, 8, 3, 0, 0, 0)), Date.UTC(2026, 8, 3), "medianoche UTC es el dia nuevo");

  const err = new AiBudgetError(budgetState(2, 2.4));
  truthy(isBudgetError(err), "AiBudgetError se reconoce");
  truthy(err.message.includes("2.40") && err.message.includes("2.00"), "el mensaje dice gastado y limite");
  eq(classifyError(err), "budget", "classifyError → budget");
  const impostor = new Error("x");
  impostor.name = "AiBudgetError";
  truthy(isBudgetError(impostor), "tambien por nombre (otra copia del modulo)");
  eq(classifyError(new Error("boom")), "transient", "un error generico sigue siendo transitorio");
}

// ---------------------------------------------------------------------------
console.log("\n# Contabilidad de una llamada");
{
  const or = {
    openrouter: {
      provider: "Google",
      usage: {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        cost: 0.00123,
        promptTokensDetails: { cachedTokens: 800 },
        completionTokensDetails: { reasoningTokens: 120 },
      },
    },
  };
  eq(
    usageFromResult({ usage: { inputTokens: 1, outputTokens: 1 }, providerMetadata: or, prices: { promptPrice: 1, completionPrice: 2 } }),
    { promptTokens: 1200, completionTokens: 300, reasoningTokens: 120, cachedTokens: 800, cost: 0.00123, costSource: "openrouter" },
    "manda la contabilidad de OpenRouter, incluido el coste",
  );

  const byok = { openrouter: { usage: { promptTokens: 10, completionTokens: 5, cost: 0.0001, costDetails: { upstreamInferenceCost: 0.002 } } } };
  near(usageFromResult({ providerMetadata: byok }).cost, 0.0021, "con BYOK se suma lo del proveedor");

  const est = usageFromResult({
    usage: { inputTokens: 100, outputTokens: 50, outputTokenDetails: { reasoningTokens: 5 }, inputTokenDetails: { cacheReadTokens: 7 } },
    prices: { promptPrice: 1, completionPrice: 2 },
  });
  eq(est.costSource, "estimate", "sin coste de OpenRouter se estima con el catalogo");
  near(est.cost, (100 * 1 + 50 * 2) / 1_000_000, "estimacion = tokens x precio por millon");
  eq([est.promptTokens, est.completionTokens, est.reasoningTokens, est.cachedTokens], [100, 50, 5, 7], "tokens del SDK");

  const none = usageFromResult({ usage: { inputTokens: 100, outputTokens: 50 } });
  eq([none.cost, none.costSource], [0, "none"], "sin precio: coste 0 y marcado como desconocido");

  const empty = usageFromResult({});
  eq(empty, { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, cost: 0, costSource: "none" }, "sin nada: ceros");

  const orNoCost = { openrouter: { usage: { promptTokens: 10, completionTokens: 5 } } };
  eq(
    usageFromResult({ providerMetadata: orNoCost, prices: { promptPrice: 10, completionPrice: 10 } }).costSource,
    "estimate",
    "contabilidad sin coste → se estima igualmente",
  );
  eq(usageFromResult({ providerMetadata: { openrouter: { usage: { cost: -1, promptTokens: 1, completionTokens: 1 } } } }).cost, 0, "coste negativo se acota a 0");
  eq(usageFromResult({ providerMetadata: "basura" }).costSource, "none", "metadata rara no rompe");
  eq(usageFromResult({ usage: { inputTokens: 12.6 } }).promptTokens, 13, "tokens se redondean");
}

// ---------------------------------------------------------------------------
console.log("\n# Historial del chat");
{
  const h = (role: "user" | "assistant", content: string) => ({ role, content });
  eq(trimHistory([], { maxChars: 100, perMessage: 50 }), [], "vacio");

  const kept = trimHistory([h("user", "a"), h("assistant", "b"), h("user", "c")], { maxChars: 100, perMessage: 50 });
  eq(kept.map((m) => m.content), ["a", "b", "c"], "todo cabe: orden intacto, del mas antiguo al mas nuevo");

  const dropped = trimHistory([h("user", "aaaa"), h("assistant", "bbbb"), h("user", "cccc")], { maxChars: 8, perMessage: 50 });
  eq(dropped.map((m) => m.content), ["bbbb", "cccc"], "se cae lo mas antiguo, se conserva lo reciente");

  const cut = trimHistory([h("user", "x".repeat(100))], { maxChars: 1000, perMessage: 10 });
  eq(cut[0].content.length, 10, "mensaje largo recortado a perMessage");
  truthy(cut[0].content.endsWith("…"), "con elipsis");

  const cutCounts = trimHistory([h("user", "x".repeat(100)), h("assistant", "y".repeat(100))], { maxChars: 15, perMessage: 10 });
  eq(cutCounts.length, 1, "el recorte cuenta para el total (10 + 10 > 15)");
  eq(cutCounts[0].role, "assistant", "y sobrevive el mas reciente");

  const same = [h("user", "hola")];
  truthy(trimHistory(same)[0] === same[0], "sin recorte se devuelve el mismo objeto (sin copias)");
  truthy(CHAT_LIMITS.historyChars >= 10_000 && CHAT_LIMITS.messageChars >= 1000, "limites por defecto sensatos");
}

// ---------------------------------------------------------------------------
console.log("\n# Agregados del panel");
{
  const now = Date.UTC(2026, 8, 2, 15, 0, 0);
  const row = (over: Partial<CallRowLike>): CallRowLike => ({
    purpose: "news_summary",
    model: "m",
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    cachedTokens: 0,
    cost: 0.01,
    costSource: "openrouter",
    ms: 1000,
    ok: true,
    error: null,
    createdAt: now - 60_000,
    ...over,
  });
  const rows: CallRowLike[] = [
    row({}), // hoy
    row({ createdAt: dayStartUtc(now) - 1, cost: 0.02, purpose: "extract", ms: 3000 }), // ayer (semana)
    row({ createdAt: now - 10 * 86400_000, cost: 0.03, purpose: "extract", ms: 5000 }), // mes
    row({ createdAt: now - 31 * 86400_000, cost: 100 }), // fuera
    row({ ok: false, error: "boom", cost: 0, costSource: "none", purpose: "extract", createdAt: now - 30_000, ms: 20 }), // fallo hoy
    row({ costSource: "none", cost: 0, createdAt: now - 20_000 }), // ok sin coste conocido
  ];
  const r = summarizeCalls(rows, now);
  eq([r.today.calls, r.today.failed], [3, 1], "hoy: 3 llamadas, 1 fallida");
  near(r.today.cost, 0.01, "coste de hoy");
  eq(r.today.unknownCost, 1, "una llamada correcta sin coste conocido");
  eq(r.week.calls, 4, "semana incluye ayer");
  near(r.week.cost, 0.03, "coste de la semana");
  eq(r.month.calls, 5, "mes excluye la de hace 31 dias");
  near(r.month.cost, 0.06, "coste del mes");
  eq(r.byPurpose.map((p) => p.purpose), ["extract", "news_summary"], "por tipo, de mas caro a mas barato");
  const ex = r.byPurpose[0];
  eq([ex.calls, ex.failed], [3, 1], "extract: 3 llamadas, 1 fallida");
  eq(ex.avgMs, 4000, "media de ms solo sobre las correctas");
  eq(ex.label, "Extraccion de eventos", "etiqueta legible");
  eq(r.lastErrors.length, 1, "un fallo listado");
  eq(r.lastErrors[0].error, "boom", "con su mensaje");

  const many = Array.from({ length: 8 }, (_, i) => row({ ok: false, error: `e${i}`, createdAt: now - i * 1000 }));
  const r2 = summarizeCalls(many, now);
  eq(r2.lastErrors.length, 5, "como mucho 5 fallos");
  eq(r2.lastErrors[0].error, "e0", "el mas reciente primero");
  eq(summarizeCalls([], now).byPurpose, [], "sin filas, sin tipos");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
