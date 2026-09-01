import { z } from "zod";

/**
 * Taxonomia de eventos. Cerrada a proposito: el modelo tiene que elegir una
 * y no inventar categorias, asi los eventos se pueden filtrar y comparar.
 */
export const EVENT_TYPES = [
  "earnings",
  "guidance",
  "m_and_a",
  "product",
  "regulation",
  "legal",
  "management",
  "capital",
  "macro",
  "sector",
  "supply_chain",
  "customer",
  "competition",
  "crypto_protocol",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  earnings: "Resultados",
  guidance: "Guidance",
  m_and_a: "M&A",
  product: "Producto",
  regulation: "Regulacion",
  legal: "Legal",
  management: "Direccion",
  capital: "Capital",
  macro: "Macro",
  sector: "Sector",
  supply_chain: "Cadena de suministro",
  customer: "Clientes",
  competition: "Competencia",
  crypto_protocol: "Protocolo",
  other: "Otro",
};

export const TIME_HORIZONS = ["immediate", "short", "medium", "long"] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];

export const HORIZON_LABELS: Record<TimeHorizon, string> = {
  immediate: "0-7 dias",
  short: "1-6 meses",
  medium: "6-24 meses",
  long: "2-10 anos",
};

export const PRIORITIES = ["P1", "P2", "P3", "P4", "P5"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: "Critico",
  P2: "Alto",
  P3: "Relevante",
  P4: "Vigilar",
  P5: "Ruido",
};

export const FEEDBACK_VALUES = [
  "useful",
  "not_useful",
  "known",
  "speculative",
  "late",
  "irrelevant",
] as const;
export type Feedback = (typeof FEEDBACK_VALUES)[number];

/** Tier de fiabilidad de una fuente: 1 primaria ... 4 debil. */
export type SourceTier = 1 | 2 | 3 | 4;

/** Noticia tal y como entra al motor (subconjunto de la fila de `news`). */
export type IntelNews = {
  id: string;
  headline: string;
  url: string;
  source: string | null;
  summary: string | null;
  impact: string | null;
  tickers: string[];
  publishedAt: number;
};

/** Grupo de noticias que hablan del mismo hecho. */
export type Cluster = {
  key: string;
  tickers: string[];
  items: IntelNews[];
  /** Fecha del hecho: la noticia mas antigua del grupo. */
  occurredAt: number;
};

/**
 * Salida del modelo, validada con Zod. Todo lo que no cumpla este esquema se
 * rechaza; nunca se guarda un evento a medias.
 */
export const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  primary_symbol: z.string().nullable(),
  companies: z.array(z.string()).max(10),
  headline: z.string().min(8).max(200),
  fact: z.string().min(10).max(1500),
  inference: z.string().max(1500),
  assessment: z.string().max(1500),
  materiality: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  thesis_impact: z.number().int().min(-100).max(100),
  time_horizon: z.enum(TIME_HORIZONS),
  is_noise: z.boolean(),
});
export type ExtractedEvent = z.infer<typeof eventSchema>;
