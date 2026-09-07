import { dailyCloses, SHALLOW_HISTORY_DAYS } from "./market/crypto-history";

/**
 * Lado cripto del oráculo. Sin estados financieros no hay análisis
 * fundamental, así que no se disfraza: es un MODELO DE CICLO sobre precio,
 * etiquetado como tal.
 *
 * La idea es una ESCALERA con confirmación, no un "compra más cuanto más
 * caiga". Dos piezas:
 *
 *  1. Profundidad desde el MÁXIMO HISTÓRICO (años de historia, no una ventana
 *     móvil de 365 días): cerca del máximo se aporta menos y se acumula
 *     reserva; a cada tramo de caída le corresponde un tramo mayor.
 *  2. Confirmación: mientras el precio siga marcando MÍNIMOS NUEVOS, el tramo
 *     grande NO se libera. Se aporta lo normal y el resto engorda la reserva.
 *     Así una caída del 35% que sigue camino del 60% no consume la munición
 *     que hace falta abajo.
 *
 * El modelo no predice dónde está el suelo — nadie puede. Solo se niega a
 * gastarlo todo antes de saberlo.
 */

/** Días sin marcar un mínimo nuevo para dar por pausada la caída. */
export const CONFIRM_DAYS = 21;
/** Ventana para decidir qué es un "mínimo nuevo". */
export const LOW_LOOKBACK = 90;
export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 2;

/**
 * La escalera: a cada profundidad desde el máximo histórico le corresponde un
 * multiplicador del aporte mensual. Se elige el primer tramo cuya caída se
 * haya alcanzado. Editable: es el criterio, no una ley.
 */
export const LADDER: Array<{ atOrBelowPct: number; multiplier: number; label: string }> = [
  { atOrBelowPct: -75, multiplier: 2, label: "caída superior al 75%: capitulación" },
  { atOrBelowPct: -65, multiplier: 1.75, label: "caída superior al 65%" },
  { atOrBelowPct: -50, multiplier: 1.5, label: "caída superior al 50%" },
  { atOrBelowPct: -35, multiplier: 1.25, label: "caída superior al 35%" },
  { atOrBelowPct: -10, multiplier: 1, label: "lejos del máximo, sin caída fuerte" },
  { atOrBelowPct: 0, multiplier: 0.5, label: "a menos del 10% del máximo histórico" },
];

export type CycleStats = {
  price: number;
  /** Máximo de toda la historia disponible (no de los últimos 365 días). */
  ath: number | null;
  athDaysAgo: number | null;
  /** Caída desde ese máximo, en % (≤ 0). */
  drawdownPct: number | null;
  ma200: number | null;
  distToMaPct: number | null;
  /** Días desde el último mínimo nuevo; null si no hay historia para saberlo. */
  daysSinceNewLow: number | null;
  /** true = sigue marcando mínimos nuevos, la caída no ha parado. */
  makingNewLows: boolean;
  days: number;
  /** true si hay menos de ~2 años: el "máximo" puede no ser el real. */
  shallowHistory: boolean;
};

/**
 * Días desde el último cierre que perforó el mínimo de los `lookback` días
 * anteriores. Un precio plano NO cuenta como mínimo nuevo (tiene que romperlo,
 * no igualarlo). Puro.
 */
export function daysSinceNewLow(closes: number[], lookback = LOW_LOOKBACK): number | null {
  if (closes.length < lookback + 2) return null;
  for (let i = closes.length - 1; i >= lookback; i--) {
    let prevMin = Infinity;
    for (let j = i - lookback; j < i; j++) if (closes[j] < prevMin) prevMin = closes[j];
    if (closes[i] < prevMin) return closes.length - 1 - i;
  }
  return closes.length - 1 - lookback;
}

/** Estado de ciclo a partir de cierres diarios (cronológicos, último = actual). */
export function cycleStats(closes: number[]): CycleStats | null {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (c.length === 0) return null;
  const price = c[c.length - 1];

  let ath = -Infinity;
  let athIdx = -1;
  for (let i = 0; i < c.length; i++) {
    if (c[i] > ath) {
      ath = c[i];
      athIdx = i;
    }
  }
  const last200 = c.slice(-200);
  const ma200 = last200.length >= 150 ? last200.reduce((s, x) => s + x, 0) / last200.length : null;
  const since = daysSinceNewLow(c);

  return {
    price,
    ath: round(ath, 2),
    athDaysAgo: athIdx >= 0 ? c.length - 1 - athIdx : null,
    drawdownPct: ath > 0 ? round((price / ath - 1) * 100, 1) : null,
    ma200: ma200 !== null ? round(ma200, 2) : null,
    distToMaPct: ma200 !== null ? round((price / ma200 - 1) * 100, 1) : null,
    daysSinceNewLow: since,
    makingNewLows: since !== null && since < CONFIRM_DAYS,
    days: c.length,
    shallowHistory: c.length < SHALLOW_HISTORY_DAYS,
  };
}

/** Tramo de la escalera que corresponde a una caída. Puro. */
export function ladderFor(drawdownPct: number): { multiplier: number; label: string } {
  for (const step of LADDER) {
    if (drawdownPct <= step.atOrBelowPct) return { multiplier: step.multiplier, label: step.label };
  }
  const last = LADDER[LADDER.length - 1];
  return { multiplier: last.multiplier, label: last.label };
}

export type CycleDecision = {
  /** Lo que se aporta de verdad este mes. */
  multiplier: number;
  /** Lo que pedía la escalera solo por profundidad. */
  ladderMultiplier: number;
  /** false = el tramo grande está retenido esperando que pare la caída. */
  confirmed: boolean;
  reason: string;
};

/**
 * Decisión del mes: escalera por profundidad, retenida mientras el precio siga
 * haciendo mínimos nuevos. Sin datos, aporte normal.
 */
export function cycleMultiplier(s: CycleStats | null): CycleDecision {
  if (!s || s.drawdownPct === null) {
    return { multiplier: 1, ladderMultiplier: 1, confirmed: true, reason: "sin datos de ciclo: aporte normal" };
  }
  const dd = s.drawdownPct;
  const { multiplier: ladder, label } = ladderFor(dd);
  const depth = `${Math.abs(Math.round(dd))}% por debajo del máximo${s.shallowHistory ? " conocido (histórico corto)" : " histórico"}`;

  // Cerca del máximo se aporta menos: la diferencia se guarda para más abajo.
  if (ladder < 1) {
    return { multiplier: ladder, ladderMultiplier: ladder, confirmed: true, reason: `${depth}: aportar menos y guardar reserva` };
  }
  if (ladder === 1) {
    return { multiplier: 1, ladderMultiplier: 1, confirmed: true, reason: `${depth}: aporte normal` };
  }
  // Tramo grande: solo si la caída ha dejado de marcar mínimos nuevos.
  if (s.makingNewLows) {
    return {
      multiplier: 1,
      ladderMultiplier: ladder,
      confirmed: false,
      reason: `${depth}, pero sigue marcando mínimos nuevos (el último hace ${s.daysSinceNewLow} días): aporte normal y el resto a reserva, esperando que pare`,
    };
  }
  return {
    multiplier: ladder,
    ladderMultiplier: ladder,
    confirmed: true,
    reason: `${depth} (${label}) y ${s.daysSinceNewLow} días sin mínimos nuevos: soltar tramo de la escalera`,
  };
}

export type CoreWeight = { symbol: string; weightPct: number };

/** "BTC:60,ETH:40" -> pesos normalizados a 100. Ignora entradas inválidas. */
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
  ladderMultiplier: number;
  confirmed: boolean;
  reason: string;
  stats: CycleStats | null;
};

export type CryptoPlan = {
  cash: number;
  lines: CryptoLine[];
  /** Lo no aportado, a stablecoin como reserva (≥ 0). */
  reserve: number;
  /** Aporte por encima del efectivo del mes que pide la escalera (informativo). */
  extra: number;
  /** true si algún tramo está retenido esperando confirmación. */
  holding: boolean;
};

/**
 * Reparte el efectivo del mes por el núcleo, escalado por la decisión de ciclo
 * de cada moneda. El multiplicador puede pedir más del 100% (caída profunda ya
 * confirmada): el exceso se reporta como `extra` para que el inversor decida
 * si tira de la reserva; nunca se asume que existe.
 */
export function cryptoPlan(
  cash: number,
  core: CoreWeight[],
  statsBySymbol: Map<string, CycleStats | null>,
  roundTo = 10,
): CryptoPlan {
  const c = Math.max(0, cash);
  const lines: CryptoLine[] = core.map((w) => {
    const base = (c * w.weightPct) / 100;
    const stats = statsBySymbol.get(w.symbol) ?? null;
    const d = cycleMultiplier(stats);
    return {
      symbol: w.symbol,
      base: Math.round(base / roundTo) * roundTo,
      amount: Math.round((base * d.multiplier) / roundTo) * roundTo,
      multiplier: d.multiplier,
      ladderMultiplier: d.ladderMultiplier,
      confirmed: d.confirmed,
      reason: d.reason,
      stats,
    };
  });
  const used = lines.reduce((s, l) => s + l.amount, 0);
  return {
    cash: c,
    lines,
    reserve: Math.max(0, c - used),
    extra: Math.max(0, used - c),
    holding: lines.some((l) => !l.confirmed),
  };
}

// ---------------------------------------------------------------------------
// Datos: histórico largo (Binance, con CoinGecko de reserva).

const TTL_MS = 6 * 60 * 60_000;
const memo = new Map<string, { at: number; value: CycleStats | null }>();

export async function cycleStatsFor(symbol: string, now = Date.now()): Promise<CycleStats | null> {
  const sym = symbol.toUpperCase();
  const hit = memo.get(sym);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const history = await dailyCloses(sym).catch(() => ({ closes: [] as number[], source: "none" as const }));
  const value = cycleStats(history.closes);
  memo.set(sym, { at: now, value });
  return value;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
