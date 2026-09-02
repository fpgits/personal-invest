import { env } from "@/lib/env";
import {
  MarketError,
  type Candle,
  type NewsItem,
  type Quote,
  type SearchHit,
} from "./types";

const BASE = "https://finnhub.io/api/v1";

async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = env.finnhubKey;
  if (!key) throw new MarketError("Falta FINNHUB_API_KEY", "finnhub");

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", key);

  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 429) {
    throw new MarketError("Rate limit de Finnhub (60/min)", "finnhub", 429);
  }
  if (!res.ok) {
    throw new MarketError(
      `Finnhub respondio ${res.status} en ${path}`,
      "finnhub",
      res.status,
    );
  }
  return (await res.json()) as T;
}

type FinnhubQuote = {
  c: number; // current
  d: number | null; // change
  dp: number | null; // change percent
  h: number;
  l: number;
  o: number;
  pc: number; // previous close
};

export async function quote(symbol: string): Promise<Quote> {
  const q = await call<FinnhubQuote>("/quote", { symbol });
  // Finnhub devuelve c=0 para simbolos que no existen o sin datos.
  if (!q || q.c === 0) {
    throw new MarketError(`Sin cotizacion para ${symbol}`, "finnhub", 404);
  }
  return {
    price: q.c,
    change: q.d ?? q.c - q.pc,
    changePct: q.dp ?? (q.pc ? ((q.c - q.pc) / q.pc) * 100 : 0),
    currency: "USD",
  };
}

type FinnhubSearch = {
  count: number;
  result: Array<{
    description: string;
    displaySymbol: string;
    symbol: string;
    type: string;
  }>;
};

export async function search(query: string): Promise<SearchHit[]> {
  const r = await call<FinnhubSearch>("/search", { q: query, exchange: "US" });
  return (r.result ?? [])
    // Nos quedamos con acciones y ETFs listados en US, sin derivados raros.
    .filter((x) => !x.symbol.includes(".") && !x.symbol.includes(":"))
    .slice(0, 15)
    .map((x) => ({
      symbol: x.displaySymbol || x.symbol,
      name: x.description,
      assetClass: (x.type === "ETP" ? "etf" : "equity") as "equity" | "etf",
      providerId: x.symbol,
    }));
}

type FinnhubProfile = {
  name?: string;
  logo?: string;
  currency?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number;
  weburl?: string;
};

export async function profile(symbol: string): Promise<FinnhubProfile | null> {
  try {
    const p = await call<FinnhubProfile>("/stock/profile2", { symbol });
    return p && p.name ? p : null;
  } catch {
    return null;
  }
}

/**
 * Velas historicas. En el plan free de Finnhub este endpoint suele estar
 * restringido, asi que devolvemos [] en vez de reventar la pagina.
 */
export async function candles(symbol: string, days = 90): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  try {
    const r = await call<{ s: string; t?: number[]; c?: number[] }>(
      "/stock/candle",
      { symbol, resolution: "D", from: String(from), to: String(to) },
    );
    if (r.s !== "ok" || !r.t || !r.c) return [];
    return r.t.map((t, i) => ({ t: t * 1000, c: r.c![i] }));
  } catch {
    return [];
  }
}

function toNews(
  raw: Array<{
    headline?: string;
    url?: string;
    source?: string;
    image?: string;
    datetime?: number;
    related?: string;
  }>,
  fallbackTicker?: string,
): NewsItem[] {
  return raw
    .filter((n) => n.headline && n.url)
    .map((n) => ({
      headline: n.headline!,
      url: n.url!,
      source: n.source ?? null,
      imageUrl: n.image || null,
      publishedAt: (n.datetime ?? 0) * 1000,
      tickers: n.related
        ? n.related.split(",").filter(Boolean)
        : fallbackTicker
          ? [fallbackTicker]
          : [],
    }))
    .filter((n) => n.publishedAt > 0);
}

export async function companyNews(symbol: string, days = 7): Promise<NewsItem[]> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  try {
    const r = await call<Parameters<typeof toNews>[0]>("/company-news", {
      symbol,
      from,
      to,
    });
    return toNews(r ?? [], symbol).slice(0, 20);
  } catch {
    return [];
  }
}

export async function marketNews(): Promise<NewsItem[]> {
  try {
    const r = await call<Parameters<typeof toNews>[0]>("/news", {
      category: "general",
    });
    return toNews(r ?? []).slice(0, 30);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fundamentales basicos (plan free): ratios, resultados y calendario.

/** Metricas con nombre estable; null cuando Finnhub no la trae. */
export type FundamentalMetrics = {
  marketCap: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  beta: number | null;
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  dividendYield: number | null;
  high52: number | null;
  low52: number | null;
};

type RawMetric = Record<string, number | string | null | undefined>;

function pick(m: RawMetric, keys: string[]): number | null {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Normaliza el diccionario de `/stock/metric`, cuyas claves cambian de nombre. */
export function normalizeMetrics(raw: RawMetric | null | undefined): FundamentalMetrics {
  const m = raw ?? {};
  return {
    marketCap: pick(m, ["marketCapitalization"]),
    pe: pick(m, ["peBasicExclExtraTTM", "peTTM", "peNormalizedAnnual", "peAnnual"]),
    ps: pick(m, ["psTTM", "psAnnual"]),
    pb: pick(m, ["pbQuarterly", "pbAnnual"]),
    beta: pick(m, ["beta"]),
    revenueGrowthYoy: pick(m, ["revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"]),
    epsGrowthYoy: pick(m, ["epsGrowthTTMYoy", "epsGrowthQuarterlyYoy"]),
    grossMargin: pick(m, ["grossMarginTTM", "grossMarginAnnual"]),
    operatingMargin: pick(m, ["operatingMarginTTM", "operatingMarginAnnual"]),
    netMargin: pick(m, ["netProfitMarginTTM", "netProfitMarginAnnual"]),
    roe: pick(m, ["roeTTM", "roeRfy"]),
    debtToEquity: pick(m, ["totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual"]),
    currentRatio: pick(m, ["currentRatioQuarterly", "currentRatioAnnual"]),
    dividendYield: pick(m, ["dividendYieldIndicatedAnnual", "currentDividendYieldTTM"]),
    high52: pick(m, ["52WeekHigh"]),
    low52: pick(m, ["52WeekLow"]),
  };
}

export async function metrics(symbol: string): Promise<FundamentalMetrics | null> {
  try {
    const r = await call<{ metric?: RawMetric }>("/stock/metric", { symbol, metric: "all" });
    if (!r?.metric || Object.keys(r.metric).length === 0) return null;
    return normalizeMetrics(r.metric);
  } catch {
    return null;
  }
}

export type EarningsQuarter = {
  period: string;
  actual: number | null;
  estimate: number | null;
  surprisePct: number | null;
};

export async function earnings(symbol: string, limit = 4): Promise<EarningsQuarter[]> {
  try {
    const r = await call<
      Array<{ period?: string; actual?: number | null; estimate?: number | null; surprisePercent?: number | null }>
    >("/stock/earnings", { symbol, limit: String(limit) });
    return (r ?? [])
      .filter((q) => q.period)
      .map((q) => ({
        period: q.period!,
        actual: q.actual ?? null,
        estimate: q.estimate ?? null,
        surprisePct: q.surprisePercent ?? null,
      }));
  } catch {
    return [];
  }
}

/** Proxima fecha de resultados en los siguientes `days` dias, o null. */
export async function nextEarnings(symbol: string, days = 120): Promise<number | null> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  try {
    const r = await call<{ earningsCalendar?: Array<{ date?: string }> }>("/calendar/earnings", {
      from,
      to,
      symbol,
    });
    const dates = (r?.earningsCalendar ?? [])
      .map((e) => (e.date ? Date.parse(`${e.date}T00:00:00Z`) : NaN))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    return dates[0] ?? null;
  } catch {
    return null;
  }
}

/** Noticias de la categoria cripto. Llegan sin ticker: se etiquetan aparte. */
export async function cryptoNews(): Promise<NewsItem[]> {
  try {
    const r = await call<Parameters<typeof toNews>[0]>("/news", { category: "crypto" });
    return toNews(r ?? []).slice(0, 40);
  } catch {
    return [];
  }
}
