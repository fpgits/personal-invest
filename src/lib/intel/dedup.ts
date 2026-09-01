import { z } from "zod";
import type { Cluster, IntelNews } from "./types";

/**
 * Deduplicacion ANTES de gastar IA. Cuatro medios contando lo mismo tienen
 * que acabar en un solo cluster, y por tanto en un solo evento.
 *
 * Dos capas:
 *  1. Lexica (aqui, sin red): titulares casi iguales que comparten ticker y
 *     ventana temporal se agrupan por similitud de tokens. Determinista y
 *     testeable.
 *  2. Semantica (extract.ts, modelo barato): agrupa parafrasis que la capa
 *     lexica no pilla, y puede enganchar un cluster a un evento reciente ya
 *     guardado. Su plan se valida aqui con `applyMergePlan`, que nunca se fia
 *     del modelo: indices desconocidos o repetidos se ignoran.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or " +
    "that the this to was were will with after amid over says said say new " +
    "el la los las de del un una y o en con por para que se su sus al es son " +
    "como mas sobre tras ante entre hacia segun sin"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9$%\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** FNV-1a de 32 bits, suficiente para una clave estable y corta. */
export function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Clave estable del cluster: tickers + dia + huella del titular mas antiguo.
 * Es UNIQUE en `events`: si dos ejecuciones derivan la misma clave, la segunda
 * se engancha al evento existente en vez de duplicarlo.
 */
export function clusterKey(tickers: string[], occurredAt: number, headline: string): string {
  const day = new Date(occurredAt).toISOString().slice(0, 10);
  const tokens = [...new Set(tokenize(headline))].sort().slice(0, 8).join(" ");
  return `${[...tickers].map((t) => t.toUpperCase()).sort().join("+")}|${day}|${hash8(tokens)}`;
}

export type LexicalOptions = {
  /** Distancia maxima entre la noticia y el inicio del cluster. */
  windowMs: number;
  /** Jaccard minimo entre titulares para considerarlos el mismo hecho. */
  threshold: number;
};

export const DEFAULT_LEXICAL: LexicalOptions = {
  windowMs: 72 * 3600_000,
  threshold: 0.5,
};

type Open = {
  tokens: Set<string>;
  tickers: Set<string>;
  items: IntelNews[];
  occurredAt: number;
};

export function lexicalClusters(
  items: IntelNews[],
  opts: LexicalOptions = DEFAULT_LEXICAL,
): Cluster[] {
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);
  const open: Open[] = [];

  for (const item of sorted) {
    const tokens = new Set(tokenize(item.headline));
    const tickers = new Set(item.tickers.map((t) => t.toUpperCase()));

    let best: Open | null = null;
    let bestSim = 0;
    for (const c of open) {
      if (item.publishedAt - c.occurredAt > opts.windowMs) continue;
      let shared = false;
      for (const t of tickers) if (c.tickers.has(t)) { shared = true; break; }
      if (!shared) continue;
      const sim = jaccard(tokens, c.tokens);
      if (sim >= opts.threshold && sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }

    if (best) {
      best.items.push(item);
      for (const t of tickers) best.tickers.add(t);
    } else {
      open.push({ tokens, tickers, items: [item], occurredAt: item.publishedAt });
    }
  }

  return open.map((c) => toCluster(c.items));
}

export function toCluster(items: IntelNews[]): Cluster {
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);
  const tickers = [...new Set(sorted.flatMap((i) => i.tickers.map((t) => t.toUpperCase())))].sort();
  const occurredAt = sorted[0].publishedAt;
  return {
    key: clusterKey(tickers, occurredAt, sorted[0].headline),
    tickers,
    items: sorted,
    occurredAt,
  };
}

/** Evento ya guardado al que un cluster nuevo se puede enganchar. */
export type ExistingEvent = {
  id: string;
  /** Alias corto que ve el modelo (E1, E2...). */
  alias: string;
  headline: string;
  companies: string[];
  occurredAt: number;
};

/** Plan de fusion que devuelve el modelo barato. */
export const mergePlanSchema = z.object({
  groups: z.array(
    z.object({
      /** Indices de clusters que son el mismo hecho. */
      members: z.array(z.number().int().min(0)).min(1).max(50),
      /** Alias de un evento existente, o null si es un hecho nuevo. */
      existing: z.string().nullable(),
    }),
  ),
});
export type MergePlan = z.infer<typeof mergePlanSchema>;

export type MergeResult = {
  clusters: Cluster[];
  attached: Array<{ eventId: string; items: IntelNews[] }>;
};

/**
 * Aplica el plan sin fiarse de el: cada indice se usa como mucho una vez, los
 * indices fuera de rango y los alias desconocidos se ignoran, y todo cluster
 * que el plan no menciona sigue tal cual.
 */
export function applyMergePlan(
  clusters: Cluster[],
  plan: MergePlan | null,
  existing: ExistingEvent[] = [],
): MergeResult {
  if (!plan) return { clusters, attached: [] };

  const byAlias = new Map(existing.map((e) => [e.alias.toUpperCase(), e]));
  const used = new Set<number>();
  const merged: Cluster[] = [];
  const attached: MergeResult["attached"] = [];

  for (const group of plan.groups) {
    const members = [...new Set(group.members)].filter(
      (i) => i < clusters.length && !used.has(i),
    );
    if (members.length === 0) continue;
    for (const i of members) used.add(i);
    const items = members.flatMap((i) => clusters[i].items);

    const target = group.existing ? byAlias.get(group.existing.toUpperCase()) : undefined;
    if (target) {
      attached.push({ eventId: target.id, items });
    } else {
      merged.push(toCluster(items));
    }
  }

  clusters.forEach((c, i) => {
    if (!used.has(i)) merged.push(c);
  });

  return { clusters: merged, attached };
}
