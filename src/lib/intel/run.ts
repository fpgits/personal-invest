import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assets,
  events,
  eventSources,
  news,
  theses,
  watchlist,
  type EventRow,
} from "@/db/schema";
import { listAssets } from "@/lib/assets";
import { computePortfolio } from "@/lib/portfolio";
import { id } from "@/lib/utils";
import {
  applyMergePlan,
  lexicalClusters,
  type ExistingEvent,
} from "./dedup";
import { extractEvent, planMerge, type ExtractContext } from "./extract";
import { portfolioRelevance, scoreSignal } from "./score";
import { bestTier, sourceTier } from "./sources";
import {
  FEEDBACK_VALUES,
  PRIORITIES,
  type Cluster,
  type Feedback,
  type IntelNews,
  type Priority,
  type SourceTier,
} from "./types";

/**
 * Orquestador del bucle: noticias nuevas → clusters → evento → score → prioridad.
 *
 * Control de coste, en este orden:
 *  1. Sin IA: descarta lo viejo, lo que no toca a ningun activo seguido y lo
 *     que el resumen barato ya marco como impacto bajo.
 *  2. Sin IA: agrupa duplicados lexicos.
 *  3. Una llamada barata: agrupa parafrasis y engancha a eventos recientes.
 *  4. Una llamada de analisis POR CLUSTER, con tope por ejecucion. Lo que no
 *     entra se queda pendiente para la siguiente.
 */
export const INTEL_LIMITS = {
  newsPerRun: 60,
  extractionsPerRun: 12,
  /** Noticias mas viejas que esto se descartan: una alerta tardia es ruido. */
  maxAgeDays: 14,
  /** Ventana en la que un cluster nuevo puede engancharse a un evento previo. */
  attachWindowDays: 5,
} as const;

export type RunStats = {
  scanned: number;
  skipped: number;
  clusters: number;
  attached: number;
  created: number;
  noise: number;
  deferred: number;
  invalid: number;
  transient: number;
  /** Ultimo error del modelo, para verlo en la UI y en los logs sin adivinar. */
  error?: string;
};

export async function processEvents(
  limits: Partial<typeof INTEL_LIMITS> = {},
): Promise<RunStats> {
  const L = { ...INTEL_LIMITS, ...limits };
  const stats: RunStats = {
    scanned: 0, skipped: 0, clusters: 0, attached: 0,
    created: 0, noise: 0, deferred: 0, invalid: 0, transient: 0,
  };
  const now = Date.now();

  const pending = await db
    .select()
    .from(news)
    .where(and(isNull(news.eventProcessedAt), isNotNull(news.processedAt)))
    .orderBy(desc(news.publishedAt))
    .limit(L.newsPerRun);
  stats.scanned = pending.length;
  if (pending.length === 0) return stats;

  const ctx = await buildContext();
  const tracked = new Set(ctx.tracked.map((t) => t.symbol.toUpperCase()));

  // 1. Filtro sin IA.
  const eligible: IntelNews[] = [];
  const skip: string[] = [];
  for (const n of pending) {
    const tickers = parseTickers(n.tickers).filter((t) => tracked.has(t));
    const tooOld = now - n.publishedAt > L.maxAgeDays * 86400_000;
    if (tooOld || tickers.length === 0 || n.impact === "low") {
      skip.push(n.id);
      continue;
    }
    eligible.push({
      id: n.id,
      headline: n.headline,
      url: n.url,
      source: n.source,
      summary: n.summary,
      impact: n.impact,
      tickers,
      publishedAt: n.publishedAt,
    });
  }
  await markProcessed(skip, now);
  stats.skipped = skip.length;
  if (eligible.length === 0) return stats;

  // 2 y 3. Dedup lexica + plan semantico (una llamada barata).
  const lexical = lexicalClusters(eligible);
  const existing = await recentForAttach(now - L.attachWindowDays * 86400_000);
  const plan = await planMerge(lexical, existing);
  const merged = applyMergePlan(lexical, plan, existing);
  stats.clusters = merged.clusters.length;

  for (const a of merged.attached) {
    await attachSources(a.eventId, a.items, now);
    stats.attached++;
  }

  // 4. Extraccion con tope: primero lo que mas pinta tiene de importar.
  const ordered = [...merged.clusters].sort(byPromise);
  const budget = ordered.slice(0, L.extractionsPerRun);
  stats.deferred = ordered.length - budget.length;

  for (const cluster of budget) {
    const res = await extractEvent(cluster, ctx);
    if (!res.ok) {
      console.warn(`[intel] extraccion ${res.kind} (${cluster.key}): ${res.message}`);
      stats.error = res.message;
      if (res.kind === "invalid") {
        stats.invalid++;
        await markProcessed(cluster.items.map((i) => i.id), now);
        continue;
      }
      // Fallo transitorio (red, cuota, modelo mal configurado): no tiene
      // sentido quemar el resto del presupuesto en la misma pasada. Lo que
      // queda sigue pendiente y se reintenta en el siguiente cron.
      stats.transient++;
      stats.deferred += budget.length - budget.indexOf(cluster) - 1;
      break;
    }

    const ev = res.event;
    const tier = bestTier(cluster.items.map((i) => sourceTier(i.source, i.url)));
    const relevance = portfolioRelevance(ev.companies, ctx.relevance);
    const { score, priority } = scoreSignal({
      materiality: ev.materiality,
      confidence: ev.confidence,
      thesisImpact: ev.thesis_impact,
      portfolioRelevance: relevance,
      sourceTier: tier,
      isNoise: ev.is_noise,
    });

    const primaryAssetId = ev.primary_symbol
      ? (ctx.assetIdBySymbol.get(ev.primary_symbol) ?? null)
      : null;

    const inserted = await db
      .insert(events)
      .values({
        id: id(),
        type: ev.type,
        primaryAssetId,
        companies: JSON.stringify(ev.companies),
        headline: ev.headline,
        fact: ev.fact,
        inference: ev.inference,
        assessment: ev.assessment,
        materiality: ev.materiality,
        confidence: ev.confidence,
        thesisImpact: ev.thesis_impact,
        timeHorizon: ev.time_horizon,
        portfolioRelevance: relevance,
        sourceTier: tier,
        signalScore: score,
        priority,
        occurredAt: cluster.occurredAt,
        clusterKey: cluster.key,
        model: res.model,
        promptVersion: res.promptVersion,
        createdAt: now,
      })
      .onConflictDoNothing({ target: events.clusterKey })
      .returning({ id: events.id });

    let eventId = inserted[0]?.id;
    if (!eventId) {
      // Misma clave que un evento previo: es el mismo hecho, se engancha.
      const prev = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.clusterKey, cluster.key))
        .limit(1);
      eventId = prev[0]?.id;
      if (eventId) stats.attached++;
    } else {
      if (ev.is_noise || priority === "P5") stats.noise++;
      else stats.created++;
    }

    if (eventId) await attachSources(eventId, cluster.items, now);
    else await markProcessed(cluster.items.map((i) => i.id), now);
  }

  console.log(
    `[intel] escaneadas=${stats.scanned} descartadas=${stats.skipped} clusters=${stats.clusters} ` +
      `nuevos=${stats.created} ruido=${stats.noise} enganchados=${stats.attached} ` +
      `pendientes=${stats.deferred} invalidos=${stats.invalid} transitorios=${stats.transient}` +
      (stats.error ? ` error=${JSON.stringify(stats.error)}` : ""),
  );
  return stats;
}

export type EventSource = {
  id: string;
  headline: string;
  url: string;
  source: string | null;
  tier: SourceTier;
  publishedAt: number;
};

export type EventWithSources = Omit<EventRow, "companies"> & {
  companies: string[];
  sources: EventSource[];
};

export async function recentEvents(opts: {
  minPriority?: Priority;
  limit?: number;
} = {}): Promise<EventWithSources[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const allowed = PRIORITIES.slice(0, PRIORITIES.indexOf(opts.minPriority ?? "P4") + 1);

  const rows = await db
    .select()
    .from(events)
    .where(inArray(events.priority, [...allowed]))
    .orderBy(desc(events.occurredAt), desc(events.signalScore))
    .limit(limit);
  if (rows.length === 0) return [];

  const links = await db
    .select({
      eventId: eventSources.eventId,
      id: news.id,
      headline: news.headline,
      url: news.url,
      source: news.source,
      publishedAt: news.publishedAt,
    })
    .from(eventSources)
    .innerJoin(news, eq(eventSources.newsId, news.id))
    .where(inArray(eventSources.eventId, rows.map((r) => r.id)));

  const byEvent = new Map<string, EventSource[]>();
  for (const l of links) {
    const list = byEvent.get(l.eventId) ?? [];
    list.push({
      id: l.id,
      headline: l.headline,
      url: l.url,
      source: l.source,
      tier: sourceTier(l.source, l.url),
      publishedAt: l.publishedAt,
    });
    byEvent.set(l.eventId, list);
  }

  return rows.map((r) => ({
    ...r,
    companies: parseTickers(r.companies),
    sources: (byEvent.get(r.id) ?? []).sort((a, b) => a.tier - b.tier || a.publishedAt - b.publishedAt),
  }));
}

export async function setEventFeedback(eventId: string, feedback: Feedback | null) {
  if (feedback && !FEEDBACK_VALUES.includes(feedback)) {
    throw new Error("Feedback no valido");
  }
  await db
    .update(events)
    .set({ feedback, feedbackAt: feedback ? Date.now() : null })
    .where(eq(events.id, eventId));
}

// ---------------------------------------------------------------------------

type Context = ExtractContext & {
  relevance: Parameters<typeof portfolioRelevance>[1];
  assetIdBySymbol: Map<string, string>;
};

async function buildContext(): Promise<Context> {
  const [all, portfolio, watch, thesisRows] = await Promise.all([
    listAssets(),
    computePortfolio().catch(() => null),
    db
      .select({ symbol: assets.symbol })
      .from(watchlist)
      .innerJoin(assets, eq(watchlist.assetId, assets.id)),
    db
      .select({ symbol: assets.symbol, thesis: theses.thesis })
      .from(theses)
      .innerJoin(assets, eq(theses.assetId, assets.id)),
  ]);

  const tracked = all
    .filter((a) => a.assetClass !== "cash")
    .map((a) => ({ symbol: a.symbol.toUpperCase(), name: a.name, assetClass: a.assetClass }));
  const positions = (portfolio?.positions ?? [])
    .filter((p) => p.asset.assetClass !== "cash")
    .map((p) => ({ symbol: p.asset.symbol.toUpperCase(), weight: p.weight, group: p.group }));
  const watchSymbols = watch.map((w) => w.symbol.toUpperCase());

  return {
    tracked,
    positions,
    watchlist: watchSymbols,
    theses: new Map(thesisRows.map((t) => [t.symbol.toUpperCase(), t.thesis])),
    relevance: {
      positions,
      watchlist: watchSymbols,
      known: tracked.map((t) => t.symbol),
    },
    assetIdBySymbol: new Map(
      all.filter((a) => a.assetClass !== "cash").map((a) => [a.symbol.toUpperCase(), a.id]),
    ),
  };
}

async function recentForAttach(since: number): Promise<ExistingEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      headline: events.headline,
      companies: events.companies,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(gte(events.createdAt, since))
    .orderBy(desc(events.createdAt))
    .limit(40);
  return rows.map((r, i) => ({
    id: r.id,
    alias: `E${i + 1}`,
    headline: r.headline,
    companies: parseTickers(r.companies),
    occurredAt: r.occurredAt,
  }));
}

async function attachSources(eventId: string, items: IntelNews[], now: number) {
  if (items.length === 0) return;
  await db
    .insert(eventSources)
    .values(items.map((n) => ({ eventId, newsId: n.id })))
    .onConflictDoNothing();
  const tier = bestTier(items.map((i) => sourceTier(i.source, i.url)));
  await db
    .update(events)
    .set({ sourceTier: sql`min(${events.sourceTier}, ${tier})` })
    .where(eq(events.id, eventId));
  await markProcessed(items.map((i) => i.id), now);
}

async function markProcessed(ids: string[], at: number) {
  if (ids.length === 0) return;
  await db.update(news).set({ eventProcessedAt: at }).where(inArray(news.id, ids));
}

function parseTickers(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => String(t).toUpperCase()) : [];
  } catch {
    return [];
  }
}

/** Orden de prioridad para el presupuesto de extraccion. */
function byPromise(a: Cluster, b: Cluster): number {
  const high = (c: Cluster) => (c.items.some((i) => i.impact === "high") ? 1 : 0);
  const tier = (c: Cluster) => bestTier(c.items.map((i) => sourceTier(i.source, i.url)));
  return (
    high(b) - high(a) ||
    tier(a) - tier(b) ||
    b.items.length - a.items.length ||
    b.occurredAt - a.occurredAt
  );
}
