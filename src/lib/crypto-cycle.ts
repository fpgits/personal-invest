import { coingecko } from "./market";

/**
 * Lado cripto del oraculo. Sin estados financieros no hay analisis
 * fundamental, asi que no se disfraza: es un MODELO DE CICLO sobre precio,
 * etiquetado como tal. Un reparto nucleo fijo (p. ej. BTC 60 / ETH 40) y un
 * multiplicador mensual 0,5x-1,5x segun donde este el precio respecto a su
 * media de 200 dias y a su maximo de 12 meses: se aporta mas en caidas
 * profundas y menos cuando el precio va muy por delante de su media. Lo que
 * no se aporta queda en stablecoin como reserva para la siguiente caida.
 */

export type CycleStats = {
  price: number;
  ma200: number | null;
  high365: number | null;
  /** Distancia del precio a la media de 200 dias, en %. */
  distToMaPct: number | null;
  /** Caida desde el maximo de 12 meses, en % (<= 0). */
  drawdownPct: number | null;
};

/** Estadisticas de ciclo a partir de cierres diarios (cronologicos, ultimo = actual). */
export function cycleStats(closes: number[]): CycleStats | null {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (c.length === 0) return null;
  const price = c[c.length - 1];
  const last200 = c.slice(-200);
  const ma200 = last200.length >= 150 ? last200.reduce((s, x) => s + x, 0) / last200.length : null;
  const high365 = c.length >= 60 ? Math.max(...c.slice(-365)) : null;
  return {
    price,
    ma200: ma200 !== null ? round(ma200, 2) : null,
    high365: high365 !== null ? round(high365, 2) : null,
    distToMaPct: ma200 !== null ? round((price / ma200 - 1) * 100, 1) : null,
    drawdownPct: high365 !== null ? round((price / high365 - 1) * 100, 1) : null,
  };
}

export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 1.5;

/** Multiplicador del aporte mensual y su razon. Sin datos, 1x. */
export function cycleMultiplier(s: CycleStats | null): { multiplier: number; reason: string } {
  if (!s) return { multiplier: 1, reason: "sin datos de ciclo: aporte normal" };
  const dd = s.drawdownPct;
  const dist = s.distToMaPct;
  let m = 1;
  let reason = "precio cerca de su media: aporte normal";
  if (dd !== null && dd <= -50) {
    m = 1.5;
    reason = `caida del ${Math.abs(dd)}% desde el maximo anual: comprar el miedo`;
  } else if (dd !== null && dd <= -30) {
    m = 1.25;
    reason = `caida del ${Math.abs(dd)}% desde el maximo anual: aportar mas`;
  } else if (dist !== null && dist >= 40) {
    m = 0.6;
    reason = `${dist}% por encima de la media de 200 dias: sobreextendido, aportar menos`;
  } else if (dist !== null && dist >= 20) {
    m = 0.8;
    reason = `${dist}% por encima de la media de 200 dias: aportar algo menos`;
  } else if (dist !== null && dist <= -15) {
    m = 1.2;
    reason = `${Math.abs(dist)}% por debajo de la media de 200 dias: aportar mas`;
  }
  return { multiplier: Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, m)), reason };
}

export type CoreWeight = { symbol: string; weightPct: number };

/** "BTC:60,ETH:40" -> pesos normalizados a 100. Ignora entradas invalidas. */
export function parseCore(raw: string | null | undefined): CoreWeight[] {
  const items = (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [sym, w] = p.split(":");
      const weight = Number(w);
      return { symbol: (sym ?? "").trim().toUpperCase(), weightPct: Number.isFinite(weight) ? weight : NaN };
    })
    .filter((c) => c.symbol && Number.isFinite(c.weightPct) && c.weightPct > 0);
  const total = items.reduce((s, c) => s + c.weightPct, 0);
  if (total <= 0) return [];
  return items.map((c) => ({ symbol: c.symbol, weightPct: round((c.weightPct / total) * 100, 2) }));
}

export type CryptoLine = {
  symbol: string;
  amount: number;
  base: number;
  multiplier: number;
  reason: string;
  stats: CycleStats | null;
};

export type CryptoPlan = {
  cash: number;
  lines: CryptoLine[];
  /** Lo no aportado, a stablecoin como reserva (>= 0). */
  reserve: number;
  /** Aporte extra por encima del efectivo del mes cuando el ciclo pide comprar (informativo). */
  extra: number;
};

/**
 * Reparte el efectivo del mes por el nucleo, escalado por el multiplicador de
 * cada moneda. El multiplicador puede pedir mas del 100% (caida profunda): el
 * exceso se reporta como `extra` para que el inversor decida si tira de
 * reserva; nunca se asume que existe.
 */
export function cryptoPlan(cash: number, core: CoreWeight[], statsBySymbol: Map<string, CycleStats | null>, roundTo = 10): CryptoPlan {
  const c = Math.max(0, cash);
  const lines: CryptoLine[] = core.map((w) => {
    const base = (c * w.weightPct) / 100;
    const stats = statsBySymbol.get(w.symbol) ?? null;
    const { multiplier, reason } = cycleMultiplier(stats);
    return {
      symbol: w.symbol,
      base: Math.round(base / roundTo) * roundTo,
      amount: Math.round((base * multiplier) / roundTo) * roundTo,
      multiplier,
      reason,
      stats,
    };
  });
  const used = lines.reduce((s, l) => s + l.amount, 0);
  return {
    cash: c,
    lines,
    reserve: Math.max(0, c - used),
    extra: Math.max(0, used - c),
  };
}

// ---------------------------------------------------------------------------
// Datos (CoinGecko, gratis): un ano de cierres por moneda.

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

const TTL_MS = 6 * 60 * 60_000;
const memo = new Map<string, { at: number; value: CycleStats | null }>();

export async function cycleStatsFor(symbol: string, now = Date.now()): Promise<CycleStats | null> {
  const sym = symbol.toUpperCase();
  const hit = memo.get(sym);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let id = COIN_IDS[sym];
  if (!id) {
    const hitId = await coingecko.resolveId(sym).catch(() => null);
    id = hitId?.providerId ?? "";
  }
  let value: CycleStats | null = null;
  if (id) {
    const candles = await coingecko.chart(id, 365).catch(() => []);
    value = cycleStats(candles.map((k) => k.c));
  }
  memo.set(sym, { at: now, value });
  return value;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
