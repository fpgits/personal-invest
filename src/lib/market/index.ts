import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { priceCache, type Asset } from "@/db/schema";
import { batched, chunk } from "@/lib/utils";
import * as coingecko from "./coingecko";
import * as finnhub from "./finnhub";
import type { Candle, NewsItem, Quote, SearchHit } from "./types";

export * from "./types";
export { coingecko, finnhub };

/**
 * Cuanto vale un precio en cache antes de refrescar, por clase de activo.
 *
 * Cripto es barato de refrescar (una sola llamada a CoinGecko para todas las
 * monedas), asi que 5 minutos. Acciones son caras (una llamada a Finnhub por
 * simbolo, en tandas con pausa), asi que 20 minutos: el cron de precios corre
 * cada 15 y con TTL de 5 casi todas las cargas de pagina pagaban un refresco
 * sincrono de 1-3s que no aportaba nada.
 */
export const PRICE_TTL = {
  crypto: 5 * 60 * 1000,
  default: 20 * 60 * 1000,
} as const;

function ttlFor(assetClass: string): number {
  return assetClass === "crypto" ? PRICE_TTL.crypto : PRICE_TTL.default;
}

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

  // El efectivo vale 1:1 y no se consulta a ningun proveedor.
  const priceable = assets.filter((a) => a.assetClass !== "cash");
  const cryptos = priceable.filter(isCrypto);
  const equities = priceable.filter((a) => !isCrypto(a));

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

  /*
   * Upsert de todos los precios en una sentencia por tanda, no una por fila.
   * Con la DB en us-east-1 y las funciones en fra1, cada round trip son
   * ~90ms: 30 activos eran ~2.7s solo en escrituras; asi es un viaje.
   */
  const now = Date.now();
  const rows = [...results].map(([assetId, q]) => ({
    assetId,
    price: q.price,
    change24h: q.change,
    changePct24h: q.changePct,
    currency: q.currency,
    updatedAt: now,
  }));

  for (const part of chunk(rows, 100)) {
    await db
      .insert(priceCache)
      .values(part)
      .onConflictDoUpdate({
        target: priceCache.assetId,
        set: {
          price: sql`excluded.price`,
          change24h: sql`excluded.change_24h`,
          changePct24h: sql`excluded.change_pct_24h`,
          currency: sql`excluded.currency`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  return { updated: results.size, errors };
}

export type CachedQuote = Quote & { updatedAt: number; stale: boolean };

/** La cache se lee con el TTL de la clase de cada activo. */
export async function getCachedQuotes(
  assets: Array<Pick<Asset, "id" | "assetClass">>,
): Promise<Record<string, CachedQuote>> {
  if (assets.length === 0) return {};
  const classById = new Map(assets.map((a) => [a.id, a.assetClass]));
  const rows = await db
    .select()
    .from(priceCache)
    .where(inArray(priceCache.assetId, [...classById.keys()]));

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
        stale: now - r.updatedAt > ttlFor(classById.get(r.assetId) ?? ""),
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
  const cached = await getCachedQuotes(assets);
  const stale = assets.filter(
    (a) => a.assetClass !== "cash" && (!cached[a.id] || cached[a.id].stale),
  );
  if (stale.length === 0) return cached;

  await refreshQuotes(stale).catch(() => ({ updated: 0, errors: [] }));
  return getCachedQuotes(assets);
}

export async function getChart(asset: Asset, days = 90): Promise<Candle[]> {
  return isCrypto(asset)
    ? coingecko.chart(asset.providerId || asset.symbol.toLowerCase(), days)
    : finnhub.candles(asset.providerId || asset.symbol, days);
}

export async function getNewsFor(assets: Asset[]): Promise<NewsItem[]> {
  // Todas las acciones que sigues, no solo las primeras: con 6 llamadas por
  // tanda y 1,1 s entre tandas, 40 simbolos caben de sobra en el limite de
  // Finnhub (60/min) y el cron corre solo dos veces al dia.
  const equities = assets.filter((a) => !isCrypto(a)).slice(0, 40);
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

  // Tope generoso: lo que no se procese hoy queda en cola (selectPendingNews
  // prioriza lo mas reciente) y el presupuesto diario de IA sigue mandando.
  return out.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 150);
}
