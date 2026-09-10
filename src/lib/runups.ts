import type { DailyClose } from "./market/stooq";

/**
 * Memoria de patrones: encontrar en el pasado las GRANDES SUBIDAS y los
 * MÁXIMOS HISTÓRICOS de un activo para poder mirar después qué había en sus
 * fundamentales antes de que pasaran. La idea de Fernando: no solo el ATH,
 * también las subidas grandes (GoPro +183% en cinco días, NVDA en 2023,
 * BTC saliendo de 2020).
 *
 * Esto es la parte de PRECIO, pura sobre cierres diarios. La reconstrucción
 * de fundamentales a la fecha de cada episodio vive aparte (fundamentals-at).
 *
 * Definiciones, editables porque son criterio y no ley:
 *  - Subida grande: desde un mínimo, el precio gana ≥ minGainPct en ≤ maxDays.
 *    El pico se extiende mientras siga haciendo máximos y no retroceda más de
 *    `pullbackPct` desde el mejor cierre. Un episodio empieza donde acaba el
 *    anterior, así que un movimiento no se cuenta dos veces.
 *  - Máximo histórico: un cierre por encima de TODO lo anterior tras al menos
 *    `athGapDays` sin uno (romper el máximo de hace un año o más es un evento;
 *    hacer un máximo nuevo cada día en pleno rally no).
 *
 * Cada episodio lleva `lookbackDate`: la fecha de seis meses antes del ancla
 * (el mínimo en una subida, la ruptura en un ATH). Ahí es donde hay que mirar
 * los fundamentales "tal como se conocían entonces", sin hacer trampa con el
 * futuro.
 */

export type EpisodeKind = "runup" | "ath";

export type Episode = {
  kind: EpisodeKind;
  /** Fecha y precio del mínimo desde el que arranca (o del último ATH previo). */
  troughDate: string;
  troughPrice: number;
  /** Mejor cierre del episodio (para un ATH, el día de la ruptura y su nuevo máximo). */
  peakDate: string;
  peakPrice: number;
  gainPct: number;
  /** Días naturales de mínimo a pico. */
  days: number;
  /** Fecha ancla desde la que se mira hacia atrás. */
  anchorDate: string;
  /** anchorDate menos lookbackDays: dónde vivía el "escenario". */
  lookbackDate: string;
};

export type RunupOptions = {
  /** Ganancia mínima desde el mínimo, en %. */
  minGainPct?: number;
  /** Ventana máxima en días naturales para lograr esa ganancia. */
  maxDays?: number;
  /** Retroceso desde el mejor cierre que da el episodio por terminado, en %. */
  pullbackPct?: number;
  /** Cuánto mirar hacia atrás desde el ancla. */
  lookbackDays?: number;
};

export const RUNUP_DEFAULTS: Required<RunupOptions> = {
  minGainPct: 80,
  maxDays: 365,
  pullbackPct: 25,
  lookbackDays: 182,
};

export type AthOptions = {
  /** Días sin máximo histórico para que romperlo cuente como evento. */
  athGapDays?: number;
  lookbackDays?: number;
};

export const ATH_DEFAULTS: Required<AthOptions> = { athGapDays: 365, lookbackDays: 182 };

const DAY = 86400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

export function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Cierres válidos, ordenados y sin fechas repetidas. */
function clean(series: DailyClose[]): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const p of series) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) continue;
    if (!Number.isFinite(p.close) || p.close <= 0) continue;
    byDate.set(p.date, p.close);
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Grandes subidas. Puro. */
export function findRunups(series: DailyClose[], opts: RunupOptions = {}): Episode[] {
  const o = { ...RUNUP_DEFAULTS, ...opts };
  const s = clean(series);
  const out: Episode[] = [];
  const n = s.length;
  if (n < 2) return out;

  let i = 0;
  while (i < n) {
    // Mínimo de la ventana [j - maxDays, j] para cada j desde i.
    let found = false;
    for (let j = i + 1; j < n; j++) {
      let troughIdx = j;
      for (let k = j - 1; k >= i; k--) {
        if (daysBetween(s[k].date, s[j].date) > o.maxDays) break;
        if (s[k].close < s[troughIdx].close) troughIdx = k;
      }
      const gain = (s[j].close / s[troughIdx].close - 1) * 100;
      if (gain < o.minGainPct) continue;

      // Extender el pico: sigue mientras haga máximos y no retroceda de más.
      let peakIdx = j;
      for (let k = j + 1; k < n; k++) {
        if (daysBetween(s[troughIdx].date, s[k].date) > o.maxDays) break;
        if (s[k].close > s[peakIdx].close) peakIdx = k;
        if (s[k].close < s[peakIdx].close * (1 - o.pullbackPct / 100)) break;
      }
      const trough = s[troughIdx];
      const peak = s[peakIdx];
      out.push({
        kind: "runup",
        troughDate: trough.date,
        troughPrice: trough.close,
        peakDate: peak.date,
        peakPrice: peak.close,
        gainPct: round1((peak.close / trough.close - 1) * 100),
        days: daysBetween(trough.date, peak.date),
        anchorDate: trough.date,
        lookbackDate: shiftDate(trough.date, -o.lookbackDays),
      });
      i = peakIdx + 1;
      found = true;
      break;
    }
    if (!found) break;
  }
  return out;
}

/** Máximos históricos que rompen un techo de hace ≥ athGapDays. Puro. */
export function findAths(series: DailyClose[], opts: AthOptions = {}): Episode[] {
  const o = { ...ATH_DEFAULTS, ...opts };
  const s = clean(series);
  const out: Episode[] = [];
  if (s.length < 2) return out;

  let athIdx = 0;
  let lowSinceIdx = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].close < s[lowSinceIdx].close) lowSinceIdx = i;
    if (s[i].close > s[athIdx].close) {
      const gap = daysBetween(s[athIdx].date, s[i].date);
      if (gap >= o.athGapDays) {
        const trough = s[lowSinceIdx];
        out.push({
          kind: "ath",
          troughDate: trough.date,
          troughPrice: trough.close,
          peakDate: s[i].date,
          peakPrice: s[i].close,
          gainPct: round1((s[i].close / trough.close - 1) * 100),
          days: daysBetween(trough.date, s[i].date),
          anchorDate: s[i].date,
          lookbackDate: shiftDate(s[i].date, -o.lookbackDays),
        });
      }
      athIdx = i;
      lowSinceIdx = i;
    }
  }
  return out;
}

/** Los dos tipos, ordenados por fecha ancla. */
export function findEpisodes(series: DailyClose[], opts: RunupOptions & AthOptions = {}): Episode[] {
  return [...findRunups(series, opts), ...findAths(series, opts)].sort((a, b) =>
    a.anchorDate < b.anchorDate ? -1 : a.anchorDate > b.anchorDate ? 1 : a.kind < b.kind ? -1 : 1,
  );
}
