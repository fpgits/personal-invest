/**
 * Valoracion por flujo de caja libre. Puro y determinista: mismas entradas,
 * mismo valor. No es un precio objetivo garantizado sino una estimacion con
 * supuestos a la vista, en tres escenarios, mas el "DCF inverso": que
 * crecimiento tiene ya descontado el precio de mercado. Comparar ese
 * crecimiento implicito con el que uno considera realista es la forma mas
 * limpia de leer el margen de seguridad.
 */

export const DEFAULT_ERP = 4.5;
export const DEFAULT_TERMINAL_GROWTH = 2.5;
export const DEFAULT_YEARS = 5;
/** El crecimiento de la primera etapa se acota: nadie compone FCF al 60% cinco anos. */
export const STAGE_GROWTH_MIN = -10;
export const STAGE_GROWTH_MAX = 30;

export type DcfInput = {
  /** FCF por accion del ultimo ejercicio (> 0). */
  fcfPerShare: number;
  /** Crecimiento inicial anual del FCF, en %. Decae hacia el terminal. */
  growthPct: number;
  /** Tasa de descuento anual, en %. */
  discountPct: number;
  terminalGrowthPct?: number;
  years?: number;
};

/**
 * Tasa de descuento tipo CAPM simplificado: bono a 10 anos mas prima de riesgo
 * escalada por beta (acotada para que un beta absurdo no rompa el modelo).
 */
export function discountRate(riskFreePct: number | null, beta: number | null, erp = DEFAULT_ERP): number {
  const rf = riskFreePct ?? 4.0;
  const b = beta === null || !Number.isFinite(beta) ? 1 : Math.max(0.7, Math.min(1.6, beta));
  return round(rf + erp * b, 2);
}

/**
 * DCF a dos etapas con decaimiento lineal del crecimiento hacia el terminal y
 * valor terminal por Gordon. Devuelve valor por accion.
 */
export function dcf(input: DcfInput): number | null {
  const { fcfPerShare } = input;
  if (!Number.isFinite(fcfPerShare) || fcfPerShare <= 0) return null;
  const tg = input.terminalGrowthPct ?? DEFAULT_TERMINAL_GROWTH;
  const n = input.years ?? DEFAULT_YEARS;
  const g = Math.max(STAGE_GROWTH_MIN, Math.min(STAGE_GROWTH_MAX, input.growthPct));
  // El descuento tiene que superar al crecimiento terminal o Gordon explota.
  const r = Math.max(input.discountPct, tg + 2);

  let fcf = fcfPerShare;
  let pv = 0;
  for (let t = 1; t <= n; t++) {
    const gt = g + ((tg - g) * (t - 1)) / n;
    fcf = fcf * (1 + gt / 100);
    pv += fcf / Math.pow(1 + r / 100, t);
  }
  const terminal = (fcf * (1 + tg / 100)) / (r / 100 - tg / 100);
  pv += terminal / Math.pow(1 + r / 100, n);
  return round(pv, 2);
}

export type DcfRange = { bear: number; base: number; bull: number };

/**
 * Tres escenarios sobre el mismo FCF: bajista (mitad de crecimiento, un punto
 * mas de descuento), base y alcista (crecimiento algo mayor, medio punto menos).
 */
export function dcfRange(input: DcfInput): DcfRange | null {
  const base = dcf(input);
  if (base === null) return null;
  const g = input.growthPct;
  const bear = dcf({ ...input, growthPct: Math.min(g * 0.5, g - 3), discountPct: input.discountPct + 1 });
  const bull = dcf({ ...input, growthPct: Math.min(g * 1.25, g + 5), discountPct: input.discountPct - 0.5 });
  if (bear === null || bull === null) return null;
  return { bear, base, bull };
}

/**
 * DCF inverso: el crecimiento inicial (%) que hace que el DCF iguale al precio.
 * Biseccion sobre g; el DCF es creciente en g. Devuelve null sin FCF positivo.
 * Un resultado por encima de STAGE_GROWTH_MAX se devuelve tal cual (acotado a
 * 100) para que se vea que el precio descuenta algo dificil de justificar.
 */
export function reverseDcf(
  price: number,
  base: Omit<DcfInput, "growthPct">,
): number | null {
  if (!Number.isFinite(price) || price <= 0 || base.fcfPerShare <= 0) return null;
  const valueAt = (g: number) => dcfUnclamped({ ...base, growthPct: g });
  let lo = -30;
  let hi = 100;
  const vLo = valueAt(lo);
  const vHi = valueAt(hi);
  if (vLo === null || vHi === null) return null;
  if (vLo >= price) return lo;
  if (vHi <= price) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = valueAt(mid);
    if (v === null) return null;
    if (v < price) lo = mid;
    else hi = mid;
    if (hi - lo < 0.01) break;
  }
  return round((lo + hi) / 2, 1);
}

/** Igual que dcf() pero sin acotar el crecimiento: solo para el inverso. */
function dcfUnclamped(input: DcfInput): number | null {
  const { fcfPerShare } = input;
  if (!Number.isFinite(fcfPerShare) || fcfPerShare <= 0) return null;
  const tg = input.terminalGrowthPct ?? DEFAULT_TERMINAL_GROWTH;
  const n = input.years ?? DEFAULT_YEARS;
  const g = input.growthPct;
  const r = Math.max(input.discountPct, tg + 2);
  let fcf = fcfPerShare;
  let pv = 0;
  for (let t = 1; t <= n; t++) {
    const gt = g + ((tg - g) * (t - 1)) / n;
    fcf = fcf * (1 + gt / 100);
    pv += fcf / Math.pow(1 + r / 100, t);
  }
  const terminal = (fcf * (1 + tg / 100)) / (r / 100 - tg / 100);
  pv += terminal / Math.pow(1 + r / 100, n);
  return pv;
}

/** Margen de seguridad en %: positivo = el precio esta por debajo del valor. */
export function marginOfSafety(fair: number | null, price: number | null): number | null {
  if (fair === null || price === null || fair <= 0 || price <= 0) return null;
  return round(((fair - price) / fair) * 100, 1);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
