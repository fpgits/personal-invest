import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { priceCache, type Asset } from "@/db/schema";
import { batched } from "@/lib/utils";
import * as coingecko from "./coingecko";
import * as finnhub from "./finnhub";
import type { Candle, NewsItem, Quote, SearchHit } from "./types";

export * from "./types";
export { coingecko, finnhub };

/** Cuanto vale un precio en cache antes de refrescar. */
export const PRICE_TTL_MS = 5 * 60 * 1000;

export function isCrypto(a: Pick<Asset, "assetClass">) {
  return a.assetClass === "crypto";
}

/**
 * Busca en las dos fuentes a la vez. Si una falla, devolvemos lo de la otra
 * en vez de dejar al usuario sin resultados.
 */
export async function searchAll(query: string): Promise<SearchHit[]> {
  const [equities, cryptos] = await Promise.allSettled([
    finnhub.search(query),
    coingecko.search(query),
  ]);
  const out: SearchHit[] = [];
  if (equities.status === "fulfilled") out.push(...equities.value);
  if (cryptos.status === "fulfilled") out.push(...cryptos.value);
  return out;
}

/**
 * Refresca precios de una lista de activos y los persiste en price_cache.
 * Cripto va en una sola llamada; acciones en tandas de 8 para respetar
 * los 60 req/min de Finnhub.
 */
export async function refreshQuotes(
  assets: Asset[],
): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  const results = new Map<string, Quote>();

  const cryptos = assets.filter(isCrypto);
  const equities = assets.filter((a) => !isCrypto(a));

  if (cryptos.length > 0) {
    try {
      const ids = cryptos.map((a) => a.providerId).filter(Boolean) as string[];
      const map = await coingecko.quotes(ids);
      for (const a of cryptos) {
        const q = a.providerId ? map[a.providerId] : undefined;
        if (q) results.set(a.id, q);
      }
    } catch (e) {
      errors.push(`cripto: ${(e as Error).message}`);
    }
  }

  if (equities.length > 0) {
    await batched(equities, 8, async (a) => {
      try {
        const q = await finnhub.quote(a.providerId || a.symbol);
        results.set(a.id, q);
      } catch (e) {
        errors.push(`${a.symbol}: ${(e as Error).message}`);
      }
    }, 1100);
  }

  const now = Date.now();
  for (const [assetId, q] of results) {
    await db
      .insert(priceCache)
      .values({
        assetId,
        price: q.price,
        change24h: q.change,
        changePct24h: q.changePct,
        currency: q.currency,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: priceCache.assetId,
        set: {
          price: q.price,
          change24h: q.change,
          changePct24h: q.changePct,
          currency: q.currency,
          updatedAt: now,
        },
      });
  }

  return { updated: results.size, errors };
}

export type CachedQuote = Quote & { updatedAt: number; stale: boolean };

export async function getCachedQuotes(
  assetIds: string[],
): Promise<Record<string, CachedQuote>> {
  if (assetIds.length === 0) return {};
  const rows = await db
    .select()
    .from(priceCache)
    .where(inArray(priceCache.assetId, assetIds));

  const now = Date.now();
  return Object.fromEntries(
    rows.map((r) => [
      r.assetId,
      {
        price: r.price,
        change: r.change24h ?? 0,
        changePct: r.changePct24h ?? 0,
        currency: r.currency,
        updatedAt: r.updatedAt,
        stale: now - r.updatedAt > PRICE_TTL_MS,
      },
    ]),
  );
}

/**
 * Precios frescos: usa cache si esta dentro del TTL, si no refresca solo
 * los que hagan falta. Esto es lo que llaman las paginas.
 */
export async function getQuotes(
  assets: Asset[],
): Promise<Record<string, CachedQuote>> {
  const cached = await getCachedQuotes(assets.map((a) => a.id));
  const stale = assets.filter((a) => !cached[a.id] || cached[a.id].stale);
  if (stale.length === 0) return cached;

  await refreshQuotes(stale).catch(() => ({ updated: 0, errors: [] }));
  return getCachedQuotes(assets.map((a) => a.id));
}

export async function getChart(asset: Asset, days = 90): Promise<Candle[]> {
  return isCrypto(asset)
    ? coingecko.chart(asset.providerId || asset.symbol.toLowerCase(), days)
    : finnhub.candles(asset.providerId || asset.symbol, days);
}

export async function getNewsFor(assets: Asset[]): Promise<NewsItem[]> {
  const equities = assets.filter((a) => !isCrypto(a)).slice(0, 12);
  const seen = new Set<string>();
  const out: NewsItem[] = [];

  const perSymbol = await batched(
    equities,
    6,
    (a) => finnhub.companyNews(a.providerId || a.symbol, 5).catch(() => []),
    1100,
  );

  for (const list of perSymbol) {
    for (const n of list) {
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      out.push(n);
    }
  }

  // Relleno con noticias generales de mercado.
  for (const n of await finnhub.marketNews().catch(() => [])) {
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    out.push(n);
  }

  return out.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 60);
}
