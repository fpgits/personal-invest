export type AssetClass = "equity" | "etf" | "crypto" | "cash";

export type Quote = {
  price: number;
  change: number;
  changePct: number;
  currency: string;
};

export type SearchHit = {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Symbol de Finnhub o id de CoinGecko */
  providerId: string;
  logoUrl?: string | null;
};

export type Candle = { t: number; c: number };

export type NewsItem = {
  headline: string;
  url: string;
  source: string | null;
  imageUrl: string | null;
  publishedAt: number;
  tickers: string[];
};

/** Error que la UI puede mostrar tal cual sin filtrar secretos. */
export class MarketError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketError";
  }
}
