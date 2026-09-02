import { isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { SIGNAL_WEIGHTS, type Weights } from "./score";
import { TIER_RELIABILITY } from "./sources";
import { PRIORITIES, type Feedback, type Priority, type SourceTier } from "./types";

/**
 * Calibracion del score con TU feedback. Dos piezas:
 *  - informe: cuantos eventos de cada prioridad fueron utiles, por que fallan
 *    los demas (tarde, ya sabido, especulativo, irrelevante);
 *  - pesos: los de `SIGNAL_WEIGHTS` se pueden sobrescribir en `settings`
 *    (`intel_weights`), a mano o con la sugerencia calculada a partir de los
 *    eventos valorados. Con pocas muestras no se sugiere nada: ajustar cinco
 *    pesos con veinte votos es sobreajuste con nombre bonito.
 */
export const WEIGHTS_KEY = "intel_weights";
export const MIN_RATED_FOR_SUGGESTION = 30;
export const MIN_WEIGHT = 0.05;

export const POSITIVE_FEEDBACK = new Set<Feedback>(["useful"]);

export type CalibrationRow = {
  priority: Priority;
  feedback: Feedback;
  materiality: number;
  confidence: number;
  thesisImpact: number;
  portfolioRelevance: number;
  sourceTier: SourceTier;
};

export type PriorityStats = {
  priority: Priority;
  rated: number;
  useful: number;
  /** useful / rated, 0..1; null sin datos. */
  precision: number | null;
  byFeedback: Record<Feedback, number>;
};

export type CalibrationReport = {
  rated: number;
  total: number;
  byPriority: PriorityStats[];
  weights: Weights;
  defaultWeights: Weights;
  customized: boolean;
  suggestion: Weights | null;
  suggestionNote: string;
};

const FEEDBACKS: Feedback[] = ["useful", "not_useful", "known", "speculative", "late", "irrelevant"];

export function summarize(rows: CalibrationRow[], total: number): Omit<CalibrationReport, "weights" | "defaultWeights" | "customized" | "suggestion" | "suggestionNote"> {
  const byPriority = PRIORITIES.map((priority) => {
    const mine = rows.filter((r) => r.priority === priority);
    const byFeedback = Object.fromEntries(FEEDBACKS.map((f) => [f, 0])) as Record<Feedback, number>;
    for (const r of mine) byFeedback[r.feedback]++;
    const useful = mine.filter((r) => POSITIVE_FEEDBACK.has(r.feedback)).length;
    return {
      priority,
      rated: mine.length,
      useful,
      precision: mine.length > 0 ? useful / mine.length : null,
      byFeedback,
    };
  });
  return { rated: rows.length, total, byPriority };
}

/**
 * Sugerencia de pesos a partir de la separacion entre eventos utiles y no
 * utiles en cada componente (media de utiles menos media de no utiles,
 * en escala 0..100). Solo las separaciones positivas cuentan; se normalizan
 * a suma 1 con un suelo por componente para que nada quede a cero. Es
 * deliberadamente simple: interpretable y sin dependencias.
 */
export function suggestWeights(rows: CalibrationRow[]): { weights: Weights | null; note: string } {
  if (rows.length < MIN_RATED_FOR_SUGGESTION) {
    return {
      weights: null,
      note: `Hacen falta al menos ${MIN_RATED_FOR_SUGGESTION} eventos valorados (hay ${rows.length}).`,
    };
  }
  const useful = rows.filter((r) => POSITIVE_FEEDBACK.has(r.feedback));
  const rest = rows.filter((r) => !POSITIVE_FEEDBACK.has(r.feedback));
  if (useful.length < 5 || rest.length < 5) {
    return { weights: null, note: "Hacen falta al menos 5 valoraciones de cada tipo (utiles y no utiles)." };
  }

  const feature = (r: CalibrationRow, k: keyof Weights): number => {
    switch (k) {
      case "materiality":
        return r.materiality;
      case "confidence":
        return r.confidence;
      case "thesisImpact":
        return Math.abs(r.thesisImpact);
      case "portfolioRelevance":
        return r.portfolioRelevance;
      case "sourceReliability":
        return TIER_RELIABILITY[r.sourceTier];
    }
  };
  const mean = (xs: CalibrationRow[], k: keyof Weights) =>
    xs.reduce((a, r) => a + feature(r, k), 0) / xs.length;

  const keys = Object.keys(SIGNAL_WEIGHTS) as Array<keyof Weights>;
  const gaps = keys.map((k) => Math.max(0, (mean(useful, k) - mean(rest, k)) / 100));
  const total = gaps.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { weights: null, note: "El feedback no separa ningun componente: no hay base para cambiar los pesos." };
  }

  // Normaliza con suelo: los componentes por debajo del suelo se fijan a el
  // y el resto se reparte proporcionalmente entre los demas.
  const w = applyFloor(keys.map((_, i) => gaps[i] / total), MIN_WEIGHT);
  const weights = Object.fromEntries(keys.map((k, i) => [k, w[i]])) as Weights;
  return { weights, note: `Sugerencia calculada con ${useful.length} utiles y ${rest.length} no utiles.` };
}

/** Suma 1, ninguno por debajo de `floor` (mientras floor * n <= 1). */
export function applyFloor(values: number[], floor: number): number[] {
  const n = values.length;
  const fixed = new Set<number>();
  let out = [...values];
  for (let iter = 0; iter < n; iter++) {
    const freeIdx = out.map((_, i) => i).filter((i) => !fixed.has(i));
    const freeSum = freeIdx.reduce((a, i) => a + out[i], 0);
    const budget = 1 - fixed.size * floor;
    out = out.map((v, i) => (fixed.has(i) ? floor : freeSum > 0 ? (v / freeSum) * budget : budget / freeIdx.length));
    const below = out.map((v, i) => (!fixed.has(i) && v < floor ? i : -1)).filter((i) => i >= 0);
    if (below.length === 0) break;
    for (const i of below) fixed.add(i);
  }
  return out.map((v) => Math.round(v * 1000) / 1000);
}

export function normalizeWeights(raw: unknown): Weights | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(SIGNAL_WEIGHTS) as Array<keyof Weights>;
  const vals = keys.map((k) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.max(0, o[k] as number) : NaN));
  if (vals.some((v) => Number.isNaN(v))) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return Object.fromEntries(keys.map((k, i) => [k, Math.round((vals[i] / sum) * 1000) / 1000])) as Weights;
}

export async function loadWeights(): Promise<{ weights: Weights; customized: boolean }> {
  const raw = await getSetting(WEIGHTS_KEY).catch(() => null);
  if (!raw) return { weights: SIGNAL_WEIGHTS, customized: false };
  try {
    const w = normalizeWeights(JSON.parse(raw));
    return w ? { weights: w, customized: true } : { weights: SIGNAL_WEIGHTS, customized: false };
  } catch {
    return { weights: SIGNAL_WEIGHTS, customized: false };
  }
}

export async function saveWeights(weights: Weights | null): Promise<void> {
  await setSetting(WEIGHTS_KEY, weights ? JSON.stringify(weights) : "");
}

export async function ratedRows(): Promise<{ rows: CalibrationRow[]; total: number }> {
  const [rated, all] = await Promise.all([
    db
      .select({
        priority: events.priority,
        feedback: events.feedback,
        materiality: events.materiality,
        confidence: events.confidence,
        thesisImpact: events.thesisImpact,
        portfolioRelevance: events.portfolioRelevance,
        sourceTier: events.sourceTier,
      })
      .from(events)
      .where(isNotNull(events.feedback)),
    db.select({ id: events.id }).from(events),
  ]);
  const rows = rated
    .filter((r) => FEEDBACKS.includes(r.feedback as Feedback) && PRIORITIES.includes(r.priority as Priority))
    .map((r) => ({
      priority: r.priority as Priority,
      feedback: r.feedback as Feedback,
      materiality: r.materiality,
      confidence: r.confidence,
      thesisImpact: r.thesisImpact,
      portfolioRelevance: r.portfolioRelevance,
      sourceTier: r.sourceTier as SourceTier,
    }));
  return { rows, total: all.length };
}

export async function calibrationReport(): Promise<CalibrationReport> {
  const [{ rows, total }, { weights, customized }] = await Promise.all([ratedRows(), loadWeights()]);
  const base = summarize(rows, total);
  const s = suggestWeights(rows);
  return {
    ...base,
    weights,
    defaultWeights: SIGNAL_WEIGHTS,
    customized,
    suggestion: s.weights,
    suggestionNote: s.note,
  };
}
