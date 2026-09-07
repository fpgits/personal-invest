import { coingecko } from ".";

/**
 * Histórico diario largo de cripto, para poder hablar de CICLOS y no de los
 * últimos doce meses. CoinGecko en plan gratuito corta en 365 días, que es
 * demasiado poco: con esa ventana el "máximo" es el del año, no el máximo
 * histórico, y una caída se borra sola cuando el pico sale de la ventana.
 *
 * Binance sirve velas diarias sin clave (1000 por petición) y llega a 2017,
 * así que se pagina hacia atrás. Si Binance no responde, se cae a CoinGecko y
 * el estado se marca como histórico corto para que quien lo lea no se fíe del
 * máximo.
 */

const BINANCE = "https://api.binance.com/api/v3/klines";
const PER_REQUEST = 1000;

/** ~6 años: cubre el pico de 2021, el suelo de 2022 y el ciclo actual. */
export const HISTORY_DAYS = 2200;
/** Por debajo de esto, el "máximo histórico" no merece ese nombre. */
export const SHALLOW_HISTORY_DAYS = 730;

/** Par de Binance para un símbolo suelto. USDT es el más líquido y el más largo. */
export function binanceSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith("USDT") || s.endsWith("USDC")) return s;
  return `${s}USDT`;
}

/** Cierres de una respuesta de klines (índice 4), en orden cronológico. Puro. */
export function parseKlines(json: unknown): Array<{ openTime: number; close: number }> {
  if (!Array.isArray(json)) return [];
  const out: Array<{ openTime: number; close: number }> = [];
  for (const row of json) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const openTime = Number(row[0]);
    const close = Number(row[4]);
    if (!Number.isFinite(openTime) || !Number.isFinite(close) || close <= 0) continue;
    out.push({ openTime, close });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

export type History = { closes: number[]; source: "binance" | "coingecko" | "none" };

const TTL_MS = 12 * 60 * 60_000;
const memo = new Map<string, { at: number; value: History }>();

async function fromBinance(symbol: string, days: number): Promise<number[]> {
  const pair = binanceSymbol(symbol);
  const all: Array<{ openTime: number; close: number }> = [];
  let endTime: number | undefined;
  // Hacia atrás en tandas de 1000 hasta cubrir `days` o quedarse sin historia.
  for (let i = 0; i < Math.ceil(days / PER_REQUEST); i++) {
    const url = new URL(BINANCE);
    url.searchParams.set("symbol", pair);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("limit", String(PER_REQUEST));
    if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) break;
    const batch = parseKlines(await res.json());
    if (batch.length === 0) break;
    all.unshift(...batch);
    endTime = batch[0].openTime - 1;
    if (batch.length < PER_REQUEST) break;
  }
  // Puede haber solapes entre tandas: se deduplica por día.
  const byDay = new Map<number, number>();
  for (const k of all) byDay.set(k.openTime, k.close);
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).slice(-days);
}

export async function dailyCloses(symbol: string, days = HISTORY_DAYS, now = Date.now()): Promise<History> {
  const key = `${symbol.toUpperCase()}|${days}`;
  const hit = memo.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: History = { closes: [], source: "none" };
  try {
    const closes = await fromBinance(symbol, days);
    if (closes.length >= 200) value = { closes, source: "binance" };
  } catch {
    /* se intenta la reserva */
  }
  if (value.source === "none") {
    // Reserva: CoinGecko, con la limitación de 365 días bien señalada.
    const id = COIN_IDS[symbol.toUpperCase()] ?? (await coingecko.resolveId(symbol).catch(() => null))?.providerId ?? "";
    if (id) {
      const candles = await coingecko.chart(id, 365).catch(() => []);
      const closes = candles.map((c) => c.c).filter((c) => Number.isFinite(c) && c > 0);
      if (closes.length > 0) value = { closes, source: "coingecko" };
    }
  }
  memo.set(key, { at: now, value });
  return value;
}

const COIN_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  DOT: "polkadot",
};
