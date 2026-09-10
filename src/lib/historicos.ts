import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { assets, news, runupEpisodes, type Asset, type RunupEpisode } from "@/db/schema";
import { cycleStats, type CycleStats } from "./crypto-cycle";
import { ensureCiks } from "./edgar";
import { rawConceptsFor, snapshotAt, type Snapshot } from "./fundamentals-at";
import { datedCloses } from "./market/crypto-history";
import { dailyCloses, type DailyClose } from "./market/stooq";
import { findEpisodes, type Episode } from "./runups";
import { scanFilingText, type FilingSignal } from "./special-signals";
import { id } from "./utils";

/**
 * Memoria de patrones: recorre el histórico de precios de un activo, saca sus
 * grandes subidas y máximos históricos, y para cada uno reconstruye cómo se
 * veía el activo SEIS MESES ANTES con lo que entonces era público. Lo guarda
 * para poder mirarlo y, más adelante, para calibrar los detectores contra
 * casos reales en vez de contra el criterio de nadie.
 *
 * Bolsa: cierres de Stooq desde 2010, fundamentales de EDGAR por fecha de
 * presentación, y señales de los filings que la app ya tenía guardados con
 * fecha anterior a la de la foto. Cripto: cierres de Binance desde 2017 y el
 * estado de ciclo (caída desde máximo, media 200, mínimos nuevos) a esa fecha.
 */

export const EQUITY_HISTORY_FROM = "2010-01-01";

export type EpisodeWithContext = Episode & {
  symbol: string;
  assetClass: string;
  snapshot: Snapshot | CycleStats | null;
  signals: FilingSignal[];
};

/** Histórico diario con fecha, según la clase del activo. */
export async function priceHistoryFor(symbol: string, assetClass: string, today = new Date()): Promise<DailyClose[]> {
  if (assetClass === "crypto") return datedCloses(symbol);
  const to = today.toISOString().slice(0, 10);
  return dailyCloses(symbol, EQUITY_HISTORY_FROM, to).catch(() => []);
}

/** Estado de ciclo con los cierres hasta la fecha (sin mirar después). Puro. */
export function cycleStatsAt(series: DailyClose[], date: string): CycleStats | null {
  const closes = series.filter((p) => p.date <= date).map((p) => p.close);
  return cycleStats(closes);
}

/** Señales de filings de la app conocidas ANTES de la fecha (ventana de 270 días). */
async function signalsKnownAt(symbol: string, date: string): Promise<FilingSignal[]> {
  const toMs = Date.parse(date);
  const fromMs = toMs - 270 * 86400_000;
  const rows = await db
    .select({ body: news.body, tickers: news.tickers })
    .from(news)
    .where(and(eq(news.kind, "filing"), gte(news.publishedAt, fromMs), lte(news.publishedAt, toMs)))
    .orderBy(desc(news.publishedAt))
    .limit(40);
  const seen = new Map<string, FilingSignal>();
  for (const r of rows) {
    let tickers: string[] = [];
    try {
      tickers = JSON.parse(r.tickers) as string[];
    } catch {
      /* sin tickers */
    }
    if (!tickers.map((t) => t.toUpperCase()).includes(symbol.toUpperCase())) continue;
    for (const s of scanFilingText(r.body ?? "")) if (!seen.has(s.key)) seen.set(s.key, s);
  }
  return [...seen.values()];
}

/**
 * Episodios de un activo con su contexto. Para bolsa necesita el CIK (lo
 * resuelve si falta). Devuelve lo encontrado aunque falle la parte de
 * fundamentales: un episodio sin foto sigue siendo un episodio.
 */
export async function scanSymbol(asset: Asset, today = new Date()): Promise<EpisodeWithContext[]> {
  const series = await priceHistoryFor(asset.symbol, asset.assetClass, today);
  if (series.length < 200) return [];
  const episodes = findEpisodes(series);
  if (episodes.length === 0) return [];

  const out: EpisodeWithContext[] = [];
  if (asset.assetClass === "crypto") {
    for (const e of episodes) {
      out.push({ ...e, symbol: asset.symbol, assetClass: asset.assetClass, snapshot: cycleStatsAt(series, e.lookbackDate), signals: [] });
    }
    return out;
  }

  let cik = asset.cik ?? null;
  if (!cik) {
    const [withCik] = await ensureCiks([asset]).catch(() => [] as Asset[]);
    cik = withCik?.cik ?? null;
  }
  const raw = cik ? await rawConceptsFor(cik).catch(() => null) : null;
  for (const e of episodes) {
    const snapshot = raw ? snapshotAt(asset.symbol, e.lookbackDate, raw, series) : null;
    const signals = await signalsKnownAt(asset.symbol, e.lookbackDate).catch(() => []);
    out.push({ ...e, symbol: asset.symbol, assetClass: asset.assetClass, snapshot, signals });
  }
  return out;
}

/** Guarda (o refresca) los episodios de un activo. Devuelve cuántos hay. */
export async function saveEpisodes(list: EpisodeWithContext[], now = Date.now()): Promise<number> {
  if (list.length === 0) return 0;
  const rows: (typeof runupEpisodes.$inferInsert)[] = list.map((e) => ({
    id: id(),
    symbol: e.symbol,
    assetClass: e.assetClass,
    kind: e.kind,
    troughDate: e.troughDate,
    troughPrice: e.troughPrice,
    peakDate: e.peakDate,
    peakPrice: e.peakPrice,
    gainPct: e.gainPct,
    days: e.days,
    anchorDate: e.anchorDate,
    lookbackDate: e.lookbackDate,
    snapshot: e.snapshot ? JSON.stringify(e.snapshot) : null,
    signals: e.signals.length > 0 ? JSON.stringify(e.signals) : null,
    scannedAt: now,
  }));
  // Reescritura por símbolo: si cambia el criterio, cambia la lista.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  await db.delete(runupEpisodes).where(inArray(runupEpisodes.symbol, symbols));
  await db.insert(runupEpisodes).values(rows);
  return rows.length;
}

export type ScanResult = { symbol: string; episodes: number; error?: string };

/**
 * Recorre una lista de símbolos (por defecto, los seguidos: cartera y
 * watchlist) y guarda sus episodios. Lento a propósito: EDGAR pide calma y
 * Stooq es un servicio público. Se llama desde un botón, no desde un cron.
 */
export async function scanSymbols(symbols?: string[]): Promise<ScanResult[]> {
  const rows = symbols
    ? await db.select().from(assets).where(inArray(assets.symbol, symbols.map((s) => s.toUpperCase())))
    : await db.select().from(assets);
  const targets = rows.filter((a) => a.assetClass === "equity" || a.assetClass === "crypto");
  const results: ScanResult[] = [];
  for (const a of targets) {
    try {
      const eps = await scanSymbol(a);
      const n = await saveEpisodes(eps);
      results.push({ symbol: a.symbol, episodes: n });
    } catch (e) {
      results.push({ symbol: a.symbol, episodes: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export async function listEpisodes(limit = 200): Promise<RunupEpisode[]> {
  return db.select().from(runupEpisodes).orderBy(desc(runupEpisodes.anchorDate)).limit(limit);
}

/** Lo que había en común seis meses antes, en una tabla compacta. Puro. */
export type EpisodeRow = {
  symbol: string;
  kind: string;
  anchorDate: string;
  gainPct: number;
  days: number;
  ps: number | null;
  evToSales: number | null;
  marketCap: number | null;
  drawdownPct: number | null;
  revenueGrowthPct: number | null;
  netMarginPct: number | null;
  distress: boolean;
  catalyst: boolean;
  /** cripto */
  cycleDrawdownPct: number | null;
  daysSinceNewLow: number | null;
};

export function episodeRows(list: RunupEpisode[]): EpisodeRow[] {
  return list.map((r) => {
    let snap: Partial<Snapshot & CycleStats> = {};
    let signals: FilingSignal[] = [];
    try {
      snap = r.snapshot ? (JSON.parse(r.snapshot) as Partial<Snapshot & CycleStats>) : {};
    } catch {
      /* foto ilegible */
    }
    try {
      signals = r.signals ? (JSON.parse(r.signals) as FilingSignal[]) : [];
    } catch {
      /* señales ilegibles */
    }
    const isCrypto = r.assetClass === "crypto";
    return {
      symbol: r.symbol,
      kind: r.kind,
      anchorDate: r.anchorDate,
      gainPct: r.gainPct,
      days: r.days,
      ps: isCrypto ? null : (snap.ps ?? null),
      evToSales: isCrypto ? null : (snap.evToSales ?? null),
      marketCap: isCrypto ? null : (snap.marketCap ?? null),
      drawdownPct: isCrypto ? null : (snap.drawdownPct ?? null),
      revenueGrowthPct: isCrypto ? null : (snap.revenueGrowthPct ?? null),
      netMarginPct: isCrypto ? null : (snap.netMarginPct ?? null),
      distress: signals.some((s) => s.polarity === "distress"),
      catalyst: signals.some((s) => s.polarity === "catalyst"),
      cycleDrawdownPct: isCrypto ? (snap.drawdownPct ?? null) : null,
      daysSinceNewLow: isCrypto ? (snap.daysSinceNewLow ?? null) : null,
    };
  });
}
