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
  /**
   * Si el grupo se formo alrededor de una noticia ya consumida por un evento
   * (ancla), este es ese evento: las noticias nuevas se le enganchan sin IA.
   */
  eventId?: string;
};

/** Limites de texto que se aplican al guardar (ver sanitizeEvent). */
export const TEXT_LIMITS = {
  headline: 200,
  fact: 1500,
  inference: 1500,
  assessment: 1500,
  companies: 10,
} as const;

/**
 * Salida del modelo, validada con Zod. Estricto en lo que importa (enums,
 * booleanos, rangos numericos) y tolerante en lo cosmetico: un numero con
 * decimales se redondea y un texto largo se recorta en `sanitizeEvent`, en
 * vez de tirar a la basura un evento correcto por un parrafo de mas.
 */
const score = (min: number, max: number) =>
  z
    .number()
    .finite()
    .min(min)
    .max(max)
    .transform((n) => Math.round(n));

export const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  primary_symbol: z.string().nullable(),
  companies: z.array(z.string()),
  headline: z.string().min(8),
  fact: z.string().min(10),
  inference: z.string(),
  assessment: z.string(),
  materiality: score(0, 100),
  confidence: score(0, 100),
  thesis_impact: score(-100, 100),
  time_horizon: z.enum(TIME_HORIZONS),
  is_noise: z.boolean(),
});
export type ExtractedEvent = z.infer<typeof eventSchema>;
