import { env } from "@/lib/env";
import {
  MarketError,
  type Candle,
  type Quote,
  type SearchHit,
} from "./types";

const FREE_BASE = "https://api.coingecko.com/api/v3";
const PRO_BASE = "https://pro-api.coingecko.com/api/v3";

/**
 * Sin key: 5-15 req/min. Con demo key (gratis): 30 req/min.
 *
 * Las keys demo y pro tienen el mismo formato (CG-...), asi que no se puede
 * adivinar el plan mirando la key: el host pro se activa con COINGECKO_PRO=true.
 * Por defecto, demo sobre el host gratuito.
 */
function endpoint() {
  const key = env.coingeckoKey;
  const isPro = Boolean(key) && env.coingeckoPro;
  return {
    base: isPro ? PRO_BASE : FREE_BASE,
    header: isPro ? "x-cg-pro-api-key" : "x-cg-demo-api-key",
    key,
  };
}

async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { base, header, key } = endpoint();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers[header] = key;

  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 429) {
    throw new MarketError(
      "Rate limit de CoinGecko. Anade COINGECKO_API_KEY para subir a 30/min.",
      "coingecko",
      429,
    );
  }
  if (!res.ok) {
    throw new MarketError(
      `CoinGecko respondio ${res.status} en ${path}`,
      "coingecko",
      res.status,
    );
  }
  return (await res.json()) as T;
}

type MarketRow = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  price_change_24h: number | null;
  price_change_percentage_24h: number | null;
};

/** Una sola llamada para N monedas. Clave para no quemar el rate limit. */
export async function quotes(
  coinIds: string[],
  vs = "usd",
): Promise<Record<string, Quote>> {
  if (coinIds.length === 0) return {};
  const rows = await call<MarketRow[]>("/coins/markets", {
    vs_currency: vs,
    ids: coinIds.join(","),
    per_page: String(Math.min(coinIds.length, 250)),
    page: "1",
  });
  const out: Record<string, Quote> = {};
  for (const r of rows) {
    out[r.id] = {
      price: r.current_price,
      change: r.price_change_24h ?? 0,
      changePct: r.price_change_percentage_24h ?? 0,
      currency: vs.toUpperCase(),
    };
  }
  return out;
}

/**
 * Una fila del mercado con lo que hace falta para cribar, no solo el precio.
 * Es lo mismo que ya devuelve `/coins/markets`; aqui se le pide entero.
 */
export type TopMarketRow = {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  /** Maximo historico y cuando fue: lo que necesita la escalera de ciclo. */
  ath: number | null;
  ath_date: string | null;
  ath_change_percentage: number | null;
};

/**
 * Las N mayores por capitalizacion, en UNA peticion.
 *
 * Esta es la diferencia entre mirar dos monedas y mirar el mercado: 100
 * monedas con precio, capitalizacion, volumen y maximo historico caben en una
 * sola llamada. `ids` permite ademas asegurar que entren las tuyas aunque no
 * esten entre las primeras.
 */
export async function topMarkets(
  limit = 100,
  opts: { vs?: string; ids?: string[] } = {},
): Promise<TopMarketRow[]> {
  const params: Record<string, string> = {
    vs_currency: opts.vs ?? "usd",
    order: "market_cap_desc",
    per_page: String(Math.min(Math.max(limit, 1), 250)),
    page: "1",
    sparkline: "false",
  };
  if (opts.ids?.length) params.ids = opts.ids.join(",");
  return call<TopMarketRow[]>("/coins/markets", params);
}

export async function quote(coinId: string, vs = "usd"): Promise<Quote> {
  const all = await quotes([coinId], vs);
  const q = all[coinId];
  if (!q) throw new MarketError(`Sin cotizacion para ${coinId}`, "coingecko", 404);
  return q;
}

type SearchResponse = {
  coins: Array<{
    id: string;
    symbol: string;
    name: string;
    large?: string;
    thumb?: string;
    market_cap_rank: number | null;
  }>;
};

export async function search(query: string): Promise<SearchHit[]> {
  const r = await call<SearchResponse>("/search", { query });
  return (r.coins ?? [])
    .slice(0, 15)
    .map((c) => ({
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      assetClass: "crypto" as const,
      providerId: c.id,
      logoUrl: c.large || c.thumb || null,
    }));
}

export async function chart(
  coinId: string,
  days = 90,
  vs = "usd",
): Promise<Candle[]> {
  try {
    const r = await call<{ prices: [number, number][] }>(
      `/coins/${encodeURIComponent(coinId)}/market_chart`,
      { vs_currency: vs, days: String(days), interval: days > 90 ? "daily" : "" },
    );
    return (r.prices ?? []).map(([t, c]) => ({ t, c }));
  } catch {
    return [];
  }
}

/** Resuelve el id de CoinGecko a partir de un ticker suelto tipo "BTC". */
export async function resolveId(symbol: string): Promise<SearchHit | null> {
  const hits = await search(symbol);
  const exact = hits.find(
    (h) => h.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  return exact ?? hits[0] ?? null;
}
