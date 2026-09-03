import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assets,
  events,
  eventSources,
  news,
  settings,
  theses,
  watchlist,
  type EventRow,
  type NewsRow,
} from "@/db/schema";
import { isBudgetError } from "@/lib/ai/errors";
import { listAssets } from "@/lib/assets";
import { fundamentalsToText, getFundamentalsMap } from "@/lib/fundamentals";
import { GROUP_CLASSES, type GroupKey } from "@/lib/period-metrics";
import { computePortfolio } from "@/lib/portfolio";
import { getSetting, setSetting } from "@/lib/settings";
import { proposeFromEvent } from "@/lib/thesis";
import { id } from "@/lib/utils";
import {
  applyMergePlan,
  lexicalClusters,
  type Anchor,
  type ExistingEvent,
} from "./dedup";
import {
  extractEvent as defaultExtract,
  planMerge as defaultMerge,
  type ExtractContext,
  type ExtractResult,
} from "./extract";
import { loadWeights } from "./calibration";
import { portfolioRelevance, scoreSignal, SIGNAL_WEIGHTS, type Weights } from "./score";
import { bestTier, hostOf, sourceTier } from "./sources";
import {
  FEEDBACK_VALUES,
  PRIORITIES,
  type Cluster,
  type ExtractedEvent,
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
 *     que el resumen barato marco como impacto bajo. Lo que aun no tiene
 *     resumen NO entra (la puerta barata falla cerrada, no abierta).
 *  2. Sin IA: agrupa duplicados lexicos y engancha a eventos recientes por
 *     anclas (noticias ya consumidas), de forma determinista.
 *  3. Una llamada barata: agrupa parafrasis y engancha lo que la lexica no vio.
 *  4. Una llamada de analisis POR CLUSTER, con tope por ejecucion y fecha
 *     limite. Lo que no entra se queda pendiente para la siguiente.
 *
 * Solo corre una pasada a la vez (cerrojo en `settings`), y cada fallo cuenta
 * intentos por noticia: un cluster que falla siempre se abandona, no bloquea.
 */
export const INTEL_LIMITS = {
  newsPerRun: 60,
  extractionsPerRun: 12,
  /** Noticias mas viejas que esto se descartan: una alerta tardia es ruido. */
  maxAgeDays: 14,
  /** Ventana en la que un cluster nuevo puede engancharse a un evento previo. */
  attachWindowDays: 5,
  /** Noticias consumidas en esta ventana sirven de ancla para la dedup. */
  anchorWindowHours: 72,
  /** Fallos (de cualquier tipo) antes de abandonar una noticia. */
  maxAttempts: 3,
  /** Tiempo de pasada tras el cual no se empiezan mas extracciones. */
  deadlineMs: 200_000,
  /** Vida del cerrojo; mayor que la duracion maxima de la funcion. */
  lockTtlMs: 6 * 60_000,
  /** Propuestas de cambio de tesis (una llamada cada una) por pasada. */
  proposalsPerRun: 4,
  /** |thesis_impact| minimo para que un evento pase a contrastarse con la tesis. */
  proposalMinImpact: 40,
} as const;

export const LAST_RUN_KEY = "intel_last_run";
const LOCK_KEY = "intel_lock";

export type RunStats = {
  startedAt: number;
  finishedAt: number;
  /** cron | manual */
  trigger: string;
  scanned: number;
  skipped: number;
  /** Con ticker seguido pero sin resumen todavia: esperan al modelo rapido. */
  unsummarized: number;
  clusters: number;
  attached: number;
  created: number;
  updated: number;
  noise: number;
  deferred: number;
  invalid: number;
  rejected: number;
  transient: number;
  abandoned: number;
  /** Propuestas de cambio de tesis creadas a partir de eventos. */
  proposals: number;
  /** Ultimo error del modelo, para verlo en la UI y en los logs sin adivinar. */
  error?: string;
  warning?: string;
  /** true si otra pasada tenia el cerrojo y esta no hizo nada. */
  locked?: boolean;
  /** true si la pasada se detuvo por el presupuesto diario de IA. */
  budget?: boolean;
};

export type IntelDeps = {
  extract: (cluster: Cluster, ctx: ExtractContext) => Promise<ExtractResult>;
  merge: typeof defaultMerge;
  /** Contrasta un evento con la tesis de su activo; devuelve el id de la propuesta o null. */
  propose: (eventId: string) => Promise<string | null>;
  now: () => number;
};

const defaultDeps: IntelDeps = {
  extract: defaultExtract,
  merge: defaultMerge,
  propose: (eventId) => proposeFromEvent(eventId),
  now: () => Date.now(),
};

export async function processEvents(
  opts: { trigger?: string; limits?: Partial<typeof INTEL_LIMITS> } = {},
  deps: Partial<IntelDeps> = {},
): Promise<RunStats> {
  const D = { ...defaultDeps, ...deps };
  const L = { ...INTEL_LIMITS, ...opts.limits };
  const startedAt = D.now();
  const stats: RunStats = {
    startedAt, finishedAt: startedAt, trigger: opts.trigger ?? "manual",
    scanned: 0, skipped: 0, unsummarized: 0, clusters: 0, attached: 0, created: 0,
    updated: 0, noise: 0, deferred: 0, invalid: 0, rejected: 0, transient: 0, abandoned: 0,
    proposals: 0,
  };

  if (!(await acquireLock(startedAt, L.lockTtlMs))) {
    stats.locked = true;
    stats.warning = "Ya hay una pasada en marcha.";
    stats.finishedAt = D.now();
    return stats;
  }

  try {
    await run(stats, L, D);
  } catch (e) {
    stats.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    stats.finishedAt = D.now();
    await releaseLock();
    await setSetting(LAST_RUN_KEY, JSON.stringify(stats)).catch(() => undefined);
    console.log(
      `[intel] ${stats.trigger} escaneadas=${stats.scanned} descartadas=${stats.skipped} ` +
        `sin_resumen=${stats.unsummarized} clusters=${stats.clusters} nuevos=${stats.created} ` +
        `actualizados=${stats.updated} ruido=${stats.noise} enganchados=${stats.attached} ` +
        `pendientes=${stats.deferred} invalidos=${stats.invalid} rechazados=${stats.rejected} ` +
        `transitorios=${stats.transient} abandonados=${stats.abandoned} propuestas=${stats.proposals} ` +
        `ms=${stats.finishedAt - stats.startedAt}` +
        (stats.budget ? " presupuesto=agotado" : "") +
        (stats.error ? ` error=${JSON.stringify(stats.error)}` : "") +
        (stats.warning ? ` aviso=${JSON.stringify(stats.warning)}` : ""),
    );
  }
  return stats;
}

async function run(stats: RunStats, L: typeof INTEL_LIMITS, D: IntelDeps) {
  const now = stats.startedAt;

  const pending = await db
    .select()
    .from(news)
    .where(and(isNull(news.eventProcessedAt), isNotNull(news.processedAt)))
    .orderBy(desc(news.publishedAt))
    .limit(L.newsPerRun);
  stats.scanned = pending.length;
  if (pending.length === 0) return;

  const ctx = await buildContext(stats);
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
    if (n.eventAttempts >= L.maxAttempts) {
      skip.push(n.id);
      stats.abandoned++;
      continue;
    }
    if (!n.impact) {
      // Aun sin resumen del modelo rapido: no se toca, ya llegara.
      stats.unsummarized++;
      continue;
    }
    eligible.push(toIntelNews(n, tickers));
  }
  await markProcessed(skip, now);
  stats.skipped = skip.length;
  if (stats.unsummarized > 0) {
    stats.warning = `${stats.unsummarized} noticias esperan resumen del modelo rapido.`;
  }
  if (eligible.length === 0) return;

  // 2. Dedup lexica con anclas: lo que se parece a una noticia ya consumida
  //    se engancha a su evento sin IA.
  const anchors = await recentAnchors(now - L.anchorWindowHours * 3600_000, tracked);
  const lexical = lexicalClusters(eligible, anchors);
  const anchored = lexical.filter((c) => c.eventId);
  const fresh = lexical.filter((c) => !c.eventId);
  for (const c of anchored) {
    await attachSources(c.eventId!, c.items, now);
    stats.attached++;
  }

  // 3. Plan semantico (una llamada barata) sobre lo que queda.
  const existing = await recentForAttach(now - L.attachWindowDays * 86400_000);
  const plan = fresh.length > 0 ? await D.merge(fresh, existing) : null;
  const merged = applyMergePlan(fresh, plan, existing, L.attachWindowDays * 86400_000);
  stats.clusters = merged.clusters.length;

  // Enganches del plan: si traen evidencia mejor que la que tenia el evento
  // (p. ej. Reuters confirma lo que solo contaba un tuit), se reanaliza con
  // todas las fuentes; cuenta contra el presupuesto de extracciones.
  const reanalyses: Array<{ eventId: string; items: IntelNews[] }> = [];
  for (const a of merged.attached) {
    const target = existing.find((e) => e.id === a.eventId);
    const newTier = bestTier(a.items.map((i) => sourceTier(i.source, i.url)));
    if (target && newTier < target.sourceTier && reanalyses.length < L.extractionsPerRun) {
      reanalyses.push(a);
    } else {
      await attachSources(a.eventId, a.items, now);
      stats.attached++;
    }
  }

  // 4. Extraccion con tope: primero lo que mas pinta tiene de importar.
  const ordered = [...merged.clusters].sort(byPromise);
  const budget = ordered.slice(0, Math.max(0, L.extractionsPerRun - reanalyses.length));
  stats.deferred = ordered.length - budget.length;

  type Job = { cluster: Cluster; newItems: IntelNews[]; reanalyzeId?: string };
  const jobs: Job[] = [];
  for (const r of reanalyses) {
    const previous = await sourcesOf(r.eventId);
    jobs.push({
      cluster: { ...clusterFrom([...previous, ...r.items]), key: `reanalysis:${r.eventId}` },
      newItems: r.items,
      reanalyzeId: r.eventId,
    });
  }
  for (const cluster of budget) jobs.push({ cluster, newItems: cluster.items });

  let successes = 0;
  const material: string[] = [];
  for (let j = 0; j < jobs.length; j++) {
    const { cluster, newItems, reanalyzeId } = jobs[j];
    const remaining = jobs.length - j - 1;

    if (D.now() - stats.startedAt > L.deadlineMs) {
      stats.deferred += remaining + 1;
      stats.warning = "Se agoto el tiempo de la pasada; el resto queda pendiente.";
      break;
    }

    // Mismo hecho ya registrado (clave identica): se engancha sin gastar.
    if (!reanalyzeId) {
      const prev = await findByKey(cluster.key);
      if (prev) {
        await attachSources(prev, cluster.items, now);
        stats.attached++;
        continue;
      }
    }

    const res = await D.extract(cluster, ctx);

    if (!res.ok) {
      if (res.kind === "budget") {
        // No es un fallo: el presupuesto diario de IA se ha gastado. El
        // resto queda pendiente y se retoma manana.
        stats.budget = true;
        stats.warning = res.message;
        stats.deferred += remaining + 1;
        break;
      }
      stats.error = res.message;
      console.warn(`[intel] extraccion ${res.kind} (${cluster.key}): ${res.message}`);
      if (res.countsAttempt) {
        stats.abandoned += await bumpAttempts(newItems, L.maxAttempts, now);
      }
      if (res.kind === "invalid") {
        stats.invalid++;
        continue;
      }
      if (res.kind === "rejected") {
        stats.rejected++;
        // Si nada ha funcionado aun en esta pasada, casi seguro es un
        // problema de configuracion (modelo, salida estructurada): parar.
        if (successes === 0) {
          stats.deferred += remaining;
          break;
        }
        continue;
      }
      // Transitorio (red, cuota, 5xx): parar y dejar el resto pendiente.
      stats.transient++;
      stats.deferred += remaining;
      break;
    }

    successes++;
    const allItems = cluster.items;
    const tier = bestTier(allItems.map((i) => sourceTier(i.source, i.url)));
    const hosts = new Set(allItems.map((i) => hostOf(i.url)).filter(Boolean)).size;
    const scored = scoreFor(res.event, ctx, tier, hosts);

    if (reanalyzeId) {
      await db
        .update(events)
        .set({
          ...eventColumns(res.event, scored, ctx),
          sourceTier: tier,
          model: res.model,
          promptVersion: res.promptVersion,
        })
        .where(eq(events.id, reanalyzeId));
      await attachSources(reanalyzeId, newItems, now);
      stats.updated++;
      if (isMaterial(res.event, scored.priority, L)) material.push(reanalyzeId);
      continue;
    }

    const inserted = await db
      .insert(events)
      .values({
        id: id(),
        ...eventColumns(res.event, scored, ctx),
        sourceTier: tier,
        occurredAt: cluster.occurredAt,
        clusterKey: cluster.key,
        model: res.model,
        promptVersion: res.promptVersion,
        createdAt: now,
      })
      .onConflictDoNothing({ target: events.clusterKey })
      .returning({ id: events.id });

    let eventId: string | undefined = inserted[0]?.id;
    if (!eventId) {
      // Carrera con otra pasada: mismo hecho ya guardado, se engancha.
      eventId = await findByKey(cluster.key);
      if (eventId) stats.attached++;
    } else if (res.event.is_noise || scored.priority === "P5") {
      stats.noise++;
    } else {
      stats.created++;
      if (isMaterial(res.event, scored.priority, L)) material.push(eventId);
    }

    if (eventId) await attachSources(eventId, allItems, now);
    else await markProcessed(allItems.map((i) => i.id), now);
  }

  // 5. Los eventos materiales se contrastan con la tesis de su activo (si la
  //    hay): el modelo propone cambios de estado en los supuestos y el
  //    usuario decide. Acotado por pasada y por tiempo.
  for (const eventId of material.slice(0, L.proposalsPerRun)) {
    if (D.now() - stats.startedAt > L.deadlineMs) break;
    try {
      const created = await D.propose(eventId);
      if (created) stats.proposals++;
    } catch (e) {
      if (isBudgetError(e)) {
        stats.budget = true;
        stats.warning = e.message;
        break;
      }
      console.warn("[intel] propuesta de tesis fallo:", e instanceof Error ? e.message : String(e));
    }
  }
}

function isMaterial(ev: ExtractedEvent, priority: Priority, L: typeof INTEL_LIMITS): boolean {
  return (
    !ev.is_noise &&
    (priority === "P1" || priority === "P2" || priority === "P3") &&
    Math.abs(ev.thesis_impact) >= L.proposalMinImpact
  );
}

// ---------------------------------------------------------------------------
// Lectura

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
  /** Ventana por fecha del hecho (occurredAt), en ms. */
  fromMs?: number;
  toMs?: number;
  /** Grupo del activo principal: bolsa/cripto filtran; "all" no. */
  group?: GroupKey;
} = {}): Promise<EventWithSources[]> {
  const limit = clampInt(opts.limit, 1, 200, 50);
  const allowed = PRIORITIES.slice(0, PRIORITIES.indexOf(opts.minPriority ?? "P4") + 1);

  // Lo ultimo detectado arriba: un hecho de hace dias que se acaba de
  // analizar es novedad para ti aunque el hecho sea viejo.
  const conds = [inArray(events.priority, [...allowed])];
  if (opts.fromMs !== undefined) conds.push(gte(events.occurredAt, opts.fromMs));
  if (opts.toMs !== undefined) conds.push(lte(events.occurredAt, opts.toMs));
  // Filtro por grupo: solo eventos cuyo activo principal es de ese grupo. Los
  // eventos sin activo principal (macro) quedan fuera salvo en "Todo".
  const classes = opts.group && opts.group !== "all" ? GROUP_CLASSES[opts.group] : null;
  if (classes) {
    conds.push(
      inArray(
        events.primaryAssetId,
        db.select({ id: assets.id }).from(assets).where(inArray(assets.assetClass, classes)),
      ),
    );
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conds))
    .orderBy(desc(events.createdAt), desc(events.signalScore))
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

export async function lastRun(): Promise<RunStats | null> {
  const raw = await getSetting(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunStats;
  } catch {
    return null;
  }
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
// Cerrojo: una sola pasada a la vez. Una unica sentencia condicional, asi que
// dos pasadas simultaneas no pueden ganar las dos.

async function acquireLock(now: number, ttlMs: number): Promise<boolean> {
  const until = String(now + ttlMs);
  await db
    .insert(settings)
    .values({ key: LOCK_KEY, value: "0", updatedAt: now })
    .onConflictDoNothing();
  const won = await db
    .update(settings)
    .set({ value: until, updatedAt: now })
    .where(and(eq(settings.key, LOCK_KEY), lt(sql`CAST(${settings.value} AS INTEGER)`, now)))
    .returning({ key: settings.key });
  return won.length > 0;
}

async function releaseLock() {
  await db
    .update(settings)
    .set({ value: "0", updatedAt: Date.now() })
    .where(eq(settings.key, LOCK_KEY))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Contexto y helpers

type Context = ExtractContext & {
  relevance: Parameters<typeof portfolioRelevance>[1];
  assetIdBySymbol: Map<string, string>;
  weights: Weights;
};

async function buildContext(stats: RunStats): Promise<Context> {
  const [all, portfolio, watch, thesisRows, weightsLoaded] = await Promise.all([
    listAssets(),
    // Pesos con precios en cache: no gastamos cuota de precios ni tiempo
    // refrescando; para la relevancia basta con el ultimo valor conocido.
    computePortfolio({ cacheOnly: true }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[intel] cartera no disponible, relevancia degradada:", msg);
      stats.warning = `Cartera no disponible (${msg}); relevancia degradada.`;
      return null;
    }),
    db
      .select({ symbol: assets.symbol })
      .from(watchlist)
      .innerJoin(assets, eq(watchlist.assetId, assets.id)),
    db
      .select({ symbol: assets.symbol, thesis: theses.thesis })
      .from(theses)
      .innerJoin(assets, eq(theses.assetId, assets.id)),
    loadWeights().catch(() => ({ weights: SIGNAL_WEIGHTS, customized: false })),
  ]);

  const nonCash = all.filter((a) => a.assetClass !== "cash");
  const fundMap = await getFundamentalsMap(nonCash.map((a) => a.id)).catch(() => new Map());
  const fundamentalsBySymbol = new Map<string, string>();
  for (const a of nonCash) {
    const f = fundMap.get(a.id);
    const text = f ? fundamentalsToText(f) : "";
    if (text) fundamentalsBySymbol.set(a.symbol.toUpperCase(), text);
  }
  const tracked = nonCash.map((a) => ({
    symbol: a.symbol.toUpperCase(),
    name: a.name,
    assetClass: a.assetClass,
  }));
  const positions = (portfolio?.positions ?? [])
    .filter((p) => p.asset.assetClass !== "cash")
    .map((p) => ({ symbol: p.asset.symbol.toUpperCase(), weight: p.weight, group: p.group }));
  const watchSymbols = watch.map((w) => w.symbol.toUpperCase());

  // Un simbolo puede existir en bolsa y en cripto (LINK, GRT...). Las
  // noticias con ticker vienen de Finnhub, es decir, de bolsa: ante el
  // choque gana el activo que no es cripto.
  const assetIdBySymbol = new Map<string, string>();
  for (const a of [...nonCash].sort((x, y) => Number(x.assetClass === "crypto") - Number(y.assetClass === "crypto"))) {
    const s = a.symbol.toUpperCase();
    if (!assetIdBySymbol.has(s)) assetIdBySymbol.set(s, a.id);
  }

  return {
    tracked,
    positions,
    watchlist: watchSymbols,
    theses: new Map(thesisRows.map((t) => [t.symbol.toUpperCase(), t.thesis])),
    fundamentals: fundamentalsBySymbol,
    relevance: { positions, watchlist: watchSymbols, known: tracked.map((t) => t.symbol) },
    assetIdBySymbol,
    weights: weightsLoaded.weights,
  };
}

type Scored = { score: number; priority: Priority; relevance: number };

function scoreFor(ev: ExtractedEvent, ctx: Context, tier: SourceTier, hosts: number): Scored {
  const relevance = portfolioRelevance(ev.companies, ctx.relevance);
  const { score, priority } = scoreSignal(
    {
      materiality: ev.materiality,
      confidence: ev.confidence,
      thesisImpact: ev.thesis_impact,
      portfolioRelevance: relevance,
      sourceTier: tier,
      isNoise: ev.is_noise,
      distinctHosts: hosts,
    },
    ctx.weights,
  );
  return { score, priority, relevance };
}

function eventColumns(ev: ExtractedEvent, s: Scored, ctx: Context) {
  return {
    type: ev.type,
    primaryAssetId: ev.primary_symbol ? (ctx.assetIdBySymbol.get(ev.primary_symbol) ?? null) : null,
    companies: JSON.stringify(ev.companies),
    headline: ev.headline,
    fact: ev.fact,
    inference: ev.inference,
    assessment: ev.assessment,
    materiality: ev.materiality,
    confidence: ev.confidence,
    thesisImpact: ev.thesis_impact,
    timeHorizon: ev.time_horizon,
    portfolioRelevance: s.relevance,
    signalScore: s.score,
    priority: s.priority,
  };
}

type ExistingWithTier = ExistingEvent & { sourceTier: SourceTier };

/** Eventos recientes a los que un cluster nuevo se puede enganchar. Nunca ruido. */
async function recentForAttach(since: number): Promise<ExistingWithTier[]> {
  const rows = await db
    .select({
      id: events.id,
      headline: events.headline,
      companies: events.companies,
      occurredAt: events.occurredAt,
      sourceTier: events.sourceTier,
    })
    .from(events)
    .where(and(gte(events.occurredAt, since), inArray(events.priority, ["P1", "P2", "P3", "P4"])))
    .orderBy(desc(events.occurredAt))
    .limit(100);
  return rows.map((r, i) => ({
    id: r.id,
    alias: `E${i + 1}`,
    headline: r.headline,
    companies: parseTickers(r.companies),
    occurredAt: r.occurredAt,
    sourceTier: r.sourceTier as SourceTier,
  }));
}

/** Noticias consumidas hace poco, con su evento: semillas de la dedup lexica. */
async function recentAnchors(since: number, tracked: Set<string>): Promise<Anchor[]> {
  const rows = await db
    .select({ n: news, eventId: eventSources.eventId })
    .from(eventSources)
    .innerJoin(news, eq(eventSources.newsId, news.id))
    .where(gte(news.publishedAt, since))
    .orderBy(desc(news.publishedAt))
    .limit(300);
  return rows
    .map((r) => ({
      item: toIntelNews(r.n, parseTickers(r.n.tickers).filter((t) => tracked.has(t))),
      eventId: r.eventId,
    }))
    .filter((a) => a.item.tickers.length > 0);
}

async function findByKey(key: string): Promise<string | undefined> {
  const prev = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.clusterKey, key))
    .limit(1);
  return prev[0]?.id;
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

/** Suma un intento; las noticias que llegan al tope se abandonan. Devuelve cuantas. */
async function bumpAttempts(items: IntelNews[], max: number, now: number): Promise<number> {
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return 0;
  await db
    .update(news)
    .set({ eventAttempts: sql`${news.eventAttempts} + 1` })
    .where(inArray(news.id, ids));
  const done = await db
    .update(news)
    .set({ eventProcessedAt: now })
    .where(and(inArray(news.id, ids), gte(news.eventAttempts, max)))
    .returning({ id: news.id });
  return done.length;
}

/** Noticias ya enlazadas a un evento, como entrada de un reanalisis. */
async function sourcesOf(eventId: string): Promise<IntelNews[]> {
  const rows = await db
    .select({ n: news })
    .from(eventSources)
    .innerJoin(news, eq(eventSources.newsId, news.id))
    .where(eq(eventSources.eventId, eventId));
  return rows.map((r) => toIntelNews(r.n, parseTickers(r.n.tickers)));
}

/** Para reanalisis: las fuentes previas del evento mas las nuevas. */
function clusterFrom(items: IntelNews[]): Cluster {
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);
  return {
    key: "",
    tickers: [...new Set(sorted.flatMap((i) => i.tickers))].sort(),
    items: sorted,
    occurredAt: sorted[0].publishedAt,
  };
}

function toIntelNews(n: NewsRow, tickers: string[]): IntelNews {
  return {
    id: n.id,
    headline: n.headline,
    url: n.url,
    source: n.source,
    summary: n.summary,
    impact: n.impact,
    tickers,
    publishedAt: n.publishedAt,
    kind: n.kind,
    body: n.body,
  };
}

function parseTickers(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => String(t).toUpperCase()) : [];
  } catch {
    return [];
  }
}

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
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
