import { TIER_RELIABILITY } from "./sources";
import type { Priority, SourceTier } from "./types";

/**
 * Score de senal: ordena eventos por cuanto merecen tu atencion. No es
 * sentimiento ni prediccion de precio.
 *
 * Los pesos suman 1 y estan aqui, no repartidos por el codigo, para poder
 * recalibrarlos con el feedback (util / ruido / tarde...) sin tocar nada mas.
 */
export const SIGNAL_WEIGHTS = {
  materiality: 0.3,
  confidence: 0.2,
  thesisImpact: 0.25,
  portfolioRelevance: 0.15,
  sourceReliability: 0.1,
} as const;

/** Umbral minimo de score para cada prioridad; por debajo de P4 es P5 (ruido). */
export const PRIORITY_THRESHOLDS: Array<[Priority, number]> = [
  ["P1", 80],
  ["P2", 65],
  ["P3", 50],
  ["P4", 35],
];

/**
 * Techos duros. Un evento puede puntuar alto en materialidad y aun asi no
 * merecer una alerta: si el modelo dice que es ruido, si la unica fuente es
 * social, o si la confianza es baja, se le corta el score.
 */
export const SCORE_CAPS = {
  noise: 20,
  /** Tier 4 sin nada mejor: nunca pasa de P4, y jamas se presenta como hecho. */
  tier4: 45,
  lowConfidenceBelow: 30,
  lowConfidence: 50,
  /**
   * Una sola fuente secundaria (tier 3 o 4, un unico host) no puede ser
   * P1/P2 por mucho que el modelo se entusiasme: para eso hace falta una
   * fuente de referencia o corroboracion de otro medio.
   */
  singleWeakSource: 64,
} as const;

export type ScoreInput = {
  materiality: number;
  confidence: number;
  thesisImpact: number;
  portfolioRelevance: number;
  sourceTier: SourceTier;
  isNoise: boolean;
  /** Hosts distintos entre las fuentes del evento (corroboracion). */
  distinctHosts?: number;
};

export function priorityFor(score: number): Priority {
  for (const [priority, min] of PRIORITY_THRESHOLDS) {
    if (score >= min) return priority;
  }
  return "P5";
}

export function scoreSignal(i: ScoreInput): { score: number; priority: Priority } {
  const w = SIGNAL_WEIGHTS;
  let score =
    w.materiality * clamp(i.materiality) +
    w.confidence * clamp(i.confidence) +
    w.thesisImpact * clamp(Math.abs(i.thesisImpact)) +
    w.portfolioRelevance * clamp(i.portfolioRelevance) +
    w.sourceReliability * TIER_RELIABILITY[i.sourceTier];

  if (i.isNoise) score = Math.min(score, SCORE_CAPS.noise);
  if (i.sourceTier === 4) score = Math.min(score, SCORE_CAPS.tier4);
  if (i.confidence < SCORE_CAPS.lowConfidenceBelow) {
    score = Math.min(score, SCORE_CAPS.lowConfidence);
  }
  if (i.sourceTier >= 3 && (i.distinctHosts ?? 1) < 2) {
    score = Math.min(score, SCORE_CAPS.singleWeakSource);
  }

  score = Math.round(score * 10) / 10;
  return { score, priority: priorityFor(score) };
}

export type RelevanceContext = {
  /** Posiciones abiertas con su peso en % sobre la cartera. */
  positions: Array<{ symbol: string; weight: number }>;
  watchlist: string[];
  /** Todos los simbolos que la app conoce (posiciones cerradas incluidas). */
  known: string[];
};

/**
 * 0..100 segun lo que te toca: una posicion grande manda, la watchlist cuenta,
 * un activo que solo conoces de pasada casi nada, y lo que no sigues, cero.
 * Una posicion residual (polvo) vale lo mismo que la watchlist, no mas.
 */
export function portfolioRelevance(symbols: string[], ctx: RelevanceContext): number {
  const up = (s: string) => s.toUpperCase();
  const weights = new Map(ctx.positions.map((p) => [up(p.symbol), p.weight]));
  const watch = new Set(ctx.watchlist.map(up));
  const known = new Set(ctx.known.map(up));

  let best = 0;
  for (const raw of symbols) {
    const s = up(raw);
    let r = 0;
    if (weights.has(s)) r = 40 + Math.min(60, (weights.get(s) ?? 0) * 3);
    else if (watch.has(s)) r = 40;
    else if (known.has(s)) r = 15;
    best = Math.max(best, r);
  }
  return Math.round(best);
}

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
