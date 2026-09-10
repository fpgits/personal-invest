import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, insiderTransactions, news } from "@/db/schema";
import { companyFinancials } from "./edgar-facts";
import { getFundamentalsMap } from "./fundamentals";
import { dailyCloses } from "./market/stooq";
import { evaluateSpecial, type SpecialResult } from "./special-situations";
import { scanFilingText, type FilingSignal } from "./special-signals";

/**
 * Corre el detector de situaciones especiales sobre lo seguido (cartera y
 * watchlist, solo bolsa). Junta lo que la app ya tiene: capitalización de
 * Finnhub, ingresos/caja/deuda de EDGAR, texto de los filings guardados,
 * 13D/13G recientes y compras de insiders. Lo único nuevo que pide fuera es
 * el histórico de 5 años a Stooq para la caída desde máximos, memoizado un
 * día por símbolo.
 *
 * Mejor esfuerzo y memoizado: si algo falla, ese activo sale sin ese dato y
 * el resto sigue. Nunca bloquea el resumen.
 */

const DAY = 86400_000;
const DD_TTL_MS = 24 * 60 * 60_000;
const ddMemo = new Map<string, { at: number; value: number | null }>();

/** Caída desde el máximo de 5 años, con Stooq. null si no hay datos. */
export async function drawdown5y(symbol: string, now = Date.now()): Promise<number | null> {
  const key = symbol.toUpperCase();
  const hit = ddMemo.get(key);
  if (hit && now - hit.at < DD_TTL_MS) return hit.value;
  let value: number | null = null;
  try {
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - 5 * 365.25 * DAY).toISOString().slice(0, 10);
    const series = await dailyCloses(symbol, from, to);
    if (series.length > 20) {
      const last = series[series.length - 1].close;
      const high = series.reduce((m, p) => (p.close > m ? p.close : m), 0);
      value = high > 0 ? Math.round((last / high - 1) * 1000) / 10 : null;
    }
  } catch {
    value = null;
  }
  ddMemo.set(key, { at: now, value });
  return value;
}

/** Señales de los filings guardados de un símbolo en los últimos `days` días. */
export async function recentSignals(symbol: string, days = 180, now = Date.now()): Promise<{ signals: FilingSignal[]; stake: boolean }> {
  const rows = await db
    .select({ headline: news.headline, body: news.body, tickers: news.tickers, publishedAt: news.publishedAt })
    .from(news)
    .where(and(eq(news.kind, "filing"), gte(news.publishedAt, now - days * DAY)))
    .orderBy(desc(news.publishedAt))
    .limit(200);
  const sym = symbol.toUpperCase();
  const seen = new Map<string, FilingSignal>();
  let stake = false;
  for (const r of rows) {
    let tickers: string[] = [];
    try {
      tickers = (JSON.parse(r.tickers) as string[]).map((t) => t.toUpperCase());
    } catch {
      /* sin tickers */
    }
    if (!tickers.includes(sym)) continue;
    if (/SC 13D|SC 13G/.test(r.headline) && now - r.publishedAt <= 90 * DAY) stake = true;
    for (const s of scanFilingText(r.body ?? "")) if (!seen.has(s.key)) seen.set(s.key, s);
  }
  return { signals: [...seen.values()], stake };
}

const RUN_TTL_MS = 6 * 60 * 60_000;
let runMemo: { at: number; value: SpecialResult[] } | null = null;

/** Situaciones especiales entre lo seguido. Memoizado 6 h. */
export async function specialCandidates(now = Date.now()): Promise<SpecialResult[]> {
  if (runMemo && now - runMemo.at < RUN_TTL_MS) return runMemo.value;
  const value = await computeSpecial(now).catch(() => [] as SpecialResult[]);
  runMemo = { at: now, value };
  return value;
}

async function computeSpecial(now: number): Promise<SpecialResult[]> {
  // Igual que el motor de eventos: "seguido" es todo activo de la app
  // (cartera y watchlist). Solo bolsa con CIK, que es donde hay filings.
  const all = await db.select().from(assets).where(eq(assets.assetClass, "equity"));
  const targets = all.filter((a) => a.cik);
  if (targets.length === 0) return [];

  const fundamentals = await getFundamentalsMap(targets.map((t) => t.id));
  const buys = await db
    .select({ symbol: insiderTransactions.symbol })
    .from(insiderTransactions)
    .where(
      and(
        eq(insiderTransactions.acquired, true),
        eq(insiderTransactions.planned, false),
        gte(insiderTransactions.transactionAt, now - 30 * DAY),
        inArray(insiderTransactions.symbol, targets.map((t) => t.symbol)),
      ),
    );
  const buysBySymbol = new Map<string, number>();
  for (const b of buys) buysBySymbol.set(b.symbol, (buysBySymbol.get(b.symbol) ?? 0) + 1);

  const out: SpecialResult[] = [];
  for (const a of targets) {
    const f = fundamentals.get(a.id);
    const marketCap = f?.metrics.marketCap !== null && f?.metrics.marketCap !== undefined ? f.metrics.marketCap * 1e6 : null;
    const fin = await companyFinancials(a.cik as string).catch(() => null);
    const last = fin?.years.at(-1);
    const [dd, sig] = await Promise.all([drawdown5y(a.symbol, now), recentSignals(a.symbol, 180, now)]);
    const r = evaluateSpecial({
      symbol: a.symbol,
      marketCap,
      revenue: last?.revenue ?? null,
      cash: last?.cash ?? null,
      debt: last?.debt ?? null,
      drawdownPct: dd,
      signals: sig.signals,
      recentStake: sig.stake,
      insiderBuys: buysBySymbol.get(a.symbol) ?? 0,
    });
    if (r.tier !== "nada") out.push(r);
  }
  return out.sort((x, y) => y.score - x.score);
}
