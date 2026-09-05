import type { FundamentalMetrics, EarningsQuarter } from "./market/finnhub";
import type { FinancialsView } from "./edgar-facts";
import { multiples } from "./edgar-facts";
import { dcfRange, discountRate, marginOfSafety, reverseDcf, type DcfRange } from "./valuation";
import {
  FACTOR_LABEL,
  POSTURE_RANK,
  type FactorKey,
  type Posture,
} from "./conviction-labels";

export { FACTOR_LABEL, FACTOR_SHORT, POSTURE_LABEL, POSTURE_RANK } from "./conviction-labels";
export type { FactorKey, Posture } from "./conviction-labels";

/**
 * Motor de conviccion: convierte fundamentales en un veredicto accionable
 * (comprar / mantener / reducir / vender) con una puntuacion, los factores que
 * la sostienen, un valor razonable estimado y las condiciones que la invalidan.
 *
 * Es DETERMINISTA y PURO: mismas entradas, mismo resultado. No llama a ningun
 * modelo de IA, no inventa numeros y no ejecuta nada. Cada cifra del veredicto
 * viene de una entrada real (EDGAR 10-K, Finnhub TTM, FRED). Cuando falta un
 * dato, el factor se omite y baja la confianza; no se rellena con supuestos.
 *
 * No es "un oraculo magico": es analitica reproducible sobre analisis
 * fundamental, con los pesos y umbrales a la vista para poder ajustarlos al
 * criterio del inversor. La app sigue siendo de solo lectura: esto ACONSEJA,
 * nunca opera.
 */

// ---------------------------------------------------------------------------
// Tipos

/**
 * Peso de cada factor en la puntuacion final. Sesgado a calidad + valoracion
 * (comprar buenos negocios a precio razonable). Exportado para poder ajustarlo
 * al criterio del inversor sin tocar el resto del motor.
 */
export const WEIGHTS: Record<FactorKey, number> = {
  valuation: 0.28,
  growth: 0.24,
  quality: 0.26,
  strength: 0.12,
  consistency: 0.1,
};

export type Factor = {
  key: FactorKey;
  label: string;
  /** 0..100: mas alto = mas atractivo. null si no hay datos para calcularlo. */
  score: number | null;
  weight: number;
  /** Explicacion legible con las cifras reales que lo mueven. */
  detail: string;
};

export type ConvictionInput = {
  symbol: string;
  name?: string;
  assetClass: string;
  price: number | null;
  /** Ratios TTM de Finnhub (o null). */
  fundamentals: FundamentalMetrics | null;
  /** Historico anual de EDGAR (o null). */
  financials: FinancialsView | null;
  /** Ultimos trimestres frente a estimacion (sorpresas). */
  earnings?: EarningsQuarter[];
  /** Tipo libre de riesgo (Treasury 10A, %), para valoracion. */
  riskFreeRate: number | null;
  /**
   * Posicion actual si ya se tiene el activo. Habilita la logica de venta
   * (sobrevaloracion / deterioro). Ausente = candidato/oportunidad.
   */
  position?: { unrealizedPct: number; weight: number } | null;
};

export type ConvictionResult = {
  symbol: string;
  name: string | null;
  held: boolean;
  posture: Posture;
  /** 0..100. Puntuacion compuesta de conviccion. */
  score: number;
  /** 0..1. Cuanta de la puntuacion se apoya en datos reales (no huecos). */
  confidence: number;
  dataQuality: "full" | "partial" | "insufficient";
  factors: Factor[];
  /** Valor razonable estimado por accion (escenario base), o null. */
  fairValue: number | null;
  /** Rango bajista/base/alcista del DCF sobre FCF, si hay FCF. */
  fairRange: DcfRange | null;
  /** Como se estimo: DCF sobre FCF, o PER justificado como respaldo. */
  valuationMethod: "dcf" | "pe" | null;
  /** Crecimiento anual del FCF que el precio actual ya descuenta (DCF inverso), en %. */
  impliedGrowthPct: number | null;
  /** Margen de seguridad: (valor - precio) / valor, en %. Positivo = barato. */
  marginOfSafetyPct: number | null;
  /** Potencial frente al precio actual, en % (fairValue/price - 1). */
  upsidePct: number | null;
  /** Frase que resume por que, con las cifras que mandan. */
  rationale: string;
  /** Que debilita o rompe la tesis (fundamental + nivel de precio). */
  invalidation: string | null;
  /** Avisos de calidad de dato (por que fiarse menos del veredicto). */
  caveats: string[];
  asOf: number;
};

// ---------------------------------------------------------------------------
// Utilidades numericas

/** Interpolacion lineal por tramos, acotada en los extremos. pts: [x, y] asc. */
export function lerp(x: number, pts: Array<[number, number]>): number {
  if (pts.length === 0) return 50;
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/** Media ponderada de valores presentes; null si no hay ninguno. */
function weightedAvg(items: Array<{ v: number | null; w: number }>): number | null {
  let sum = 0;
  let wsum = 0;
  for (const { v, w } of items) {
    if (v === null || !Number.isFinite(v)) continue;
    sum += v * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function isFin(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// ---------------------------------------------------------------------------
// Metricas derivadas del historico EDGAR

/** CAGR de ingresos sobre los ultimos `maxYears` ejercicios, en %. */
export function revenueCagr(view: FinancialsView | null, maxYears = 5): number | null {
  if (!view) return null;
  const rev = view.years.filter((y) => isFin(y.revenue) && (y.revenue as number) > 0).slice(-maxYears);
  if (rev.length < 2) return null;
  const first = rev[0].revenue as number;
  const last = rev[rev.length - 1].revenue as number;
  const n = rev.length - 1;
  return round((Math.pow(last / first, 1 / n) - 1) * 100, 1);
}

/** Pendiente del margen neto (pp por ano) sobre el historico. + = mejora. */
export function marginTrend(view: FinancialsView | null): number | null {
  if (!view) return null;
  const pts = view.years
    .map((y, i) => ({ i, m: y.netMargin }))
    .filter((p): p is { i: number; m: number } => isFin(p.m));
  if (pts.length < 3) return null;
  // Regresion lineal simple margen ~ indice de ano.
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.i, 0);
  const sy = pts.reduce((s, p) => s + p.m, 0);
  const sxx = pts.reduce((s, p) => s + p.i * p.i, 0);
  const sxy = pts.reduce((s, p) => s + p.i * p.m, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return round((n * sxy - sx * sy) / denom, 2);
}

/** Fraccion de anos con beneficio neto positivo (0..1). */
function positiveEarningsFraction(view: FinancialsView | null): number | null {
  if (!view) return null;
  const ys = view.years.filter((y) => isFin(y.netIncome));
  if (ys.length === 0) return null;
  return ys.filter((y) => (y.netIncome as number) > 0).length / ys.length;
}

/**
 * Mejor estimacion de crecimiento (%) combinando fuentes, acotada para que no
 * dispare la valoracion: CAGR de ingresos (EDGAR) + crecimiento TTM (Finnhub).
 */
export function growthEstimate(input: ConvictionInput): number | null {
  const cagr = revenueCagr(input.financials);
  const revYoy = input.fundamentals?.revenueGrowthYoy ?? null;
  let epsYoy = input.fundamentals?.epsGrowthYoy ?? null;
  // El crecimiento del BPA revierte hacia el de ingresos: un rebote desde base
  // baja (p. ej. +360%) no es sostenible. Se descarta si es extremo y se acota
  // al doble del crecimiento de ventas cuando ambos existen.
  if (isFin(epsYoy)) {
    if (Math.abs(epsYoy) > 150) epsYoy = null;
    else if (isFin(revYoy)) epsYoy = Math.min(epsYoy, revYoy * 2 + 20);
  }
  const clamp = (v: number) => Math.max(-40, Math.min(70, v));
  const vals = [cagr, revYoy, epsYoy].filter(isFin).map(clamp);
  if (vals.length === 0) return null;
  // Mediana robusta frente a un dato atipico.
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(-15, Math.min(60, round(median, 1)));
}

/**
 * Fiabilidad de los beneficios TTM. Un margen neto mayor que el bruto es
 * imposible sin extraordinarios: delata beneficios distorsionados (una
 * plusvalia puntual, una reversion de impuestos). En ese caso no nos fiamos del
 * BPA para el valor razonable y lo avisamos.
 */
export function earningsReliable(f: FundamentalMetrics | null): boolean {
  if (!f) return true;
  if (isFin(f.netMargin) && isFin(f.grossMargin) && f.netMargin > f.grossMargin + 1) return false;
  return true;
}

/** FCF por accion del ultimo ejercicio (EDGAR): FCF / acciones diluidas (o en circulacion). */
export function fcfPerShare(view: FinancialsView | null): number | null {
  const last = view?.years.at(-1);
  if (!last || !isFin(last.fcf)) return null;
  const sh = last.shares ?? view?.sharesOut ?? null;
  if (!isFin(sh) || sh <= 0) return null;
  return last.fcf / sh;
}

/**
 * Senal de pico de ciclo: el margen actual muy por encima de su mediana
 * historica. Un PER bajo sobre beneficios de pico es la trampa de valor
 * clasica (memoria, semiconductores, materias primas). Necesita 4+ anos.
 */
export function peakCycle(input: ConvictionInput): { flagged: boolean; current: number | null; median: number | null } {
  const margins = (input.financials?.years ?? []).map((y) => y.netMargin).filter(isFin);
  if (margins.length < 4) return { flagged: false, current: null, median: null };
  const current = input.fundamentals?.netMargin ?? margins[margins.length - 1];
  const sorted = [...margins].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const flagged = median > 0 && current > median * 1.5 && current - median > 8;
  return { flagged, current: round(current), median: round(median) };
}

/** Conversion a caja del ultimo ejercicio: OCF / beneficio neto (1 = todo el beneficio es caja). */
export function cashConversion(view: FinancialsView | null): number | null {
  const last = view?.years.at(-1);
  if (!last || !isFin(last.ocf) || !isFin(last.netIncome) || last.netIncome <= 0) return null;
  return round(last.ocf / last.netIncome, 2);
}

/** Variacion de acciones diluidas entre el primer y ultimo ejercicio, en %. Negativo = recompras. */
export function sharesTrend(view: FinancialsView | null): number | null {
  const pts = (view?.years ?? []).map((y) => y.shares).filter((s): s is number => isFin(s) && s > 0);
  if (pts.length < 3) return null;
  return round((pts[pts.length - 1] / pts[0] - 1) * 100, 1);
}

// ---------------------------------------------------------------------------
// Factores (cada uno 0..100)

function scoreValuation(input: ConvictionInput): Factor {
  const f = input.fundamentals;
  const edgarMult =
    input.financials && input.price
      ? multiples(input.financials, input.price, f?.marketCap ? f.marketCap * 1e6 : null)
      : null;
  const pe = f?.pe ?? edgarMult?.pe ?? null;
  const ps = f?.ps ?? edgarMult?.ps ?? null;
  const pb = f?.pb ?? edgarMult?.pb ?? null;
  const growth = growthEstimate(input);

  const parts: Array<{ v: number | null; w: number }> = [];
  const bits: string[] = [];

  // Rendimiento del FCF frente al bono: la vara mas limpia (caja real, no
  // beneficio contable). Pesa mas que el PER cuando existe.
  const fps = fcfPerShare(input.financials);
  if (isFin(fps) && fps > 0 && isFin(input.price) && input.price > 0) {
    const fcfYield = (fps / input.price) * 100;
    const premium = fcfYield - (input.riskFreeRate ?? 4.0);
    parts.push({
      v: lerp(premium, [
        [-3, 12],
        [0, 40],
        [2, 60],
        [4, 78],
        [7, 92],
      ]),
      w: 1.3,
    });
    bits.push(`rend. FCF ${round(fcfYield)}% (P/FCF ${round(input.price / fps)})`);
  }

  // Rendimiento del beneficio (1/PER) frente al bono: la vara value clasica.
  if (isFin(pe) && pe > 0) {
    const ey = 100 / pe;
    if (isFin(input.riskFreeRate)) {
      const premium = ey - input.riskFreeRate;
      parts.push({
        v: lerp(premium, [
          [-3, 12],
          [0, 42],
          [2, 62],
          [5, 82],
          [8, 94],
        ]),
        w: 1.1,
      });
      bits.push(`PER ${round(pe)} (rend. ${round(ey)}% vs bono ${round(input.riskFreeRate)}%)`);
    } else {
      parts.push({ v: lerp(ey, [[3, 20], [5, 45], [8, 68], [12, 85]]), w: 1 });
      bits.push(`PER ${round(pe)}`);
    }
    // PEG: PER frente a crecimiento.
    if (isFin(growth) && growth > 1) {
      const peg = pe / growth;
      parts.push({
        v: lerp(peg, [
          [0.5, 92],
          [1, 80],
          [1.5, 62],
          [2, 46],
          [3, 28],
          [4, 15],
        ]),
        w: 1,
      });
      bits.push(`PEG ${round(peg, 2)}`);
    }
  } else if (isFin(pe) && pe <= 0) {
    // Sin beneficios: penaliza pero no anula; se juzga por ventas.
    parts.push({ v: 30, w: 0.6 });
    bits.push("sin beneficios (PER n/a)");
  }

  if (isFin(ps)) {
    parts.push({ v: lerp(ps, [[1, 78], [3, 60], [6, 45], [10, 30], [20, 15]]), w: 0.5 });
    bits.push(`P/S ${round(ps)}`);
  }
  if (isFin(pb)) {
    parts.push({ v: lerp(pb, [[1, 74], [3, 58], [6, 42], [10, 28]]), w: 0.35 });
    bits.push(`P/B ${round(pb)}`);
  }

  let score = weightedAvg(parts);
  // Multiplos baratos sobre beneficios de pico enganan: recorte.
  const peak = peakCycle(input);
  if (score !== null && peak.flagged) {
    score = score * 0.8;
    bits.push(`posible pico de ciclo (margen ${peak.current}% vs mediana ${peak.median}%)`);
  }
  return {
    key: "valuation",
    label: FACTOR_LABEL.valuation,
    score: score === null ? null : round(score),
    weight: WEIGHTS.valuation,
    detail: bits.length ? bits.join(", ") : "sin multiplos disponibles",
  };
}

function scoreGrowth(input: ConvictionInput): Factor {
  const cagr = revenueCagr(input.financials);
  const revYoy = input.fundamentals?.revenueGrowthYoy ?? null;
  const epsYoy = input.fundamentals?.epsGrowthYoy ?? null;
  const map: Array<[number, number]> = [
    [-10, 15],
    [0, 40],
    [8, 60],
    [15, 78],
    [25, 90],
    [40, 97],
  ];
  const parts: Array<{ v: number | null; w: number }> = [
    { v: isFin(cagr) ? lerp(cagr, map) : null, w: 1.1 },
    { v: isFin(revYoy) ? lerp(revYoy, map) : null, w: 1 },
    {
      v: isFin(epsYoy)
        ? lerp(epsYoy, [[-25, 22], [0, 45], [10, 62], [25, 80], [50, 92]])
        : null,
      w: 0.7,
    },
  ];
  const bits: string[] = [];
  if (isFin(cagr)) bits.push(`ingresos ${cagr > 0 ? "+" : ""}${cagr}%/ano (5a)`);
  if (isFin(revYoy)) bits.push(`ventas ${revYoy > 0 ? "+" : ""}${round(revYoy)}% a/a`);
  if (isFin(epsYoy)) bits.push(`BPA ${epsYoy > 0 ? "+" : ""}${round(epsYoy)}% a/a`);
  const score = weightedAvg(parts);
  return {
    key: "growth",
    label: FACTOR_LABEL.growth,
    score: score === null ? null : round(score),
    weight: WEIGHTS.growth,
    detail: bits.length ? bits.join(", ") : "sin datos de crecimiento",
  };
}

function scoreQuality(input: ConvictionInput): Factor {
  const f = input.fundamentals;
  const edgarMargin = input.financials?.years.at(-1)?.netMargin ?? null;
  // Si el margen neto no es fiable (neto > bruto), se descarta para no premiar
  // una distorsion puntual; el bruto y el operativo siguen contando.
  const netMargin = earningsReliable(f) ? f?.netMargin ?? edgarMargin ?? null : null;
  const grossMargin = f?.grossMargin ?? null;
  const roe = earningsReliable(f) ? f?.roe ?? null : null;
  const opMargin = f?.operatingMargin ?? null;
  const trend = marginTrend(input.financials);

  const marginMap: Array<[number, number]> = [
    [-5, 12],
    [0, 38],
    [5, 52],
    [10, 65],
    [20, 82],
    [30, 93],
  ];
  const parts: Array<{ v: number | null; w: number }> = [
    { v: isFin(netMargin) ? lerp(netMargin, marginMap) : null, w: 1.1 },
    {
      v: isFin(roe) ? lerp(roe, [[-5, 12], [5, 40], [10, 55], [15, 68], [25, 84], [40, 94]]) : null,
      w: 1,
    },
    { v: isFin(opMargin) ? lerp(opMargin, marginMap) : null, w: 0.6 },
    { v: isFin(grossMargin) ? lerp(grossMargin, [[10, 40], [30, 58], [50, 74], [70, 88]]) : null, w: 0.4 },
    {
      v: isFin(trend) ? lerp(trend, [[-3, 25], [-1, 40], [0, 50], [1, 66], [3, 82]]) : null,
      w: 0.6,
    },
  ];
  const bits: string[] = [];
  if (isFin(netMargin)) bits.push(`margen neto ${round(netMargin)}%`);
  else if (!earningsReliable(f)) bits.push("margen neto TTM no fiable (descartado)");
  if (isFin(roe)) bits.push(`ROE ${round(roe)}%`);
  if (isFin(opMargin)) bits.push(`margen op. ${round(opMargin)}%`);
  if (isFin(trend)) bits.push(`margen ${trend > 0 ? "en mejora" : trend < 0 ? "en caida" : "estable"}`);
  let score = weightedAvg(parts);
  // Beneficio que no se convierte en caja vale menos.
  const conv = cashConversion(input.financials);
  if (score !== null && isFin(conv)) {
    if (conv < 0.7) {
      score = score * 0.88;
      bits.push(`baja conversion a caja (OCF/beneficio ${conv})`);
    } else {
      bits.push(`conversion a caja ${conv}x`);
    }
  }
  return {
    key: "quality",
    label: FACTOR_LABEL.quality,
    score: score === null ? null : round(score),
    weight: WEIGHTS.quality,
    detail: bits.length ? bits.join(", ") : "sin datos de rentabilidad",
  };
}

function scoreStrength(input: ConvictionInput): Factor {
  const f = input.fundamentals;
  const de = f?.debtToEquity ?? null;
  const cr = f?.currentRatio ?? null;
  // Crecimiento del patrimonio (EDGAR): senal barata de solidez.
  const eq = (input.financials?.years ?? []).filter((y) => isFin(y.equity));
  const eqTrend =
    eq.length >= 2 && (eq[0].equity as number) > 0
      ? (eq[eq.length - 1].equity as number) / (eq[0].equity as number) - 1
      : null;

  // Deuda neta en anos de FCF: cuanto tardaria en pagarse con la caja que genera.
  const last = input.financials?.years.at(-1);
  const netDebt = last?.netDebt ?? null;
  const fcf = last?.fcf ?? null;
  const debtYears =
    isFin(netDebt) && isFin(fcf) ? (netDebt <= 0 ? 0 : fcf > 0 ? netDebt / fcf : 99) : null;

  const parts: Array<{ v: number | null; w: number }> = [
    { v: isFin(de) ? lerp(de, [[0, 90], [0.5, 75], [1, 60], [2, 42], [4, 22]]) : null, w: 1 },
    { v: isFin(cr) ? lerp(cr, [[0.8, 28], [1, 48], [1.5, 65], [2, 78], [3, 88]]) : null, w: 0.8 },
    {
      v: debtYears === null ? null : lerp(debtYears, [[0, 92], [1, 82], [3, 65], [5, 48], [8, 22]]),
      w: 1,
    },
    {
      v: eqTrend === null ? null : lerp(eqTrend * 100, [[-20, 25], [0, 48], [30, 68], [80, 85]]),
      w: 0.5,
    },
  ];
  const bits: string[] = [];
  if (isFin(netDebt)) {
    bits.push(
      netDebt <= 0
        ? "caja neta"
        : debtYears !== null && debtYears < 99
          ? `deuda neta = ${round(debtYears)} anos de FCF`
          : "deuda neta sin FCF que la cubra",
    );
  }
  if (isFin(de)) bits.push(`deuda/equity ${round(de, 2)}`);
  if (isFin(cr)) bits.push(`ratio corriente ${round(cr, 2)}`);
  const score = weightedAvg(parts);
  return {
    key: "strength",
    label: FACTOR_LABEL.strength,
    score: score === null ? null : round(score),
    weight: WEIGHTS.strength,
    detail: bits.length ? bits.join(", ") : "sin datos de balance",
  };
}

function scoreConsistency(input: ConvictionInput): Factor {
  const posFrac = positiveEarningsFraction(input.financials);
  const growthYears = (input.financials?.years ?? []).filter((y) => isFin(y.revenueGrowth));
  const posGrowthFrac =
    growthYears.length > 0
      ? growthYears.filter((y) => (y.revenueGrowth as number) > 0).length / growthYears.length
      : null;
  // Sorpresas de resultados recientes: batir estimaciones suma.
  const surprises = (input.earnings ?? []).map((e) => e.surprisePct).filter(isFin);
  const beatFrac =
    surprises.length > 0 ? surprises.filter((s) => s > 0).length / surprises.length : null;

  // Recompras sostenidas suman (menos acciones = mas beneficio por accion); la dilucion resta.
  const shTrend = sharesTrend(input.financials);

  const parts: Array<{ v: number | null; w: number }> = [
    { v: posFrac === null ? null : lerp(posFrac, [[0, 18], [0.5, 50], [1, 88]]), w: 1 },
    { v: posGrowthFrac === null ? null : lerp(posGrowthFrac, [[0, 25], [0.5, 52], [1, 85]]), w: 0.8 },
    { v: beatFrac === null ? null : lerp(beatFrac, [[0, 35], [0.5, 55], [1, 78]]), w: 0.5 },
    { v: shTrend === null ? null : lerp(shTrend, [[-15, 86], [-5, 70], [0, 55], [5, 42], [15, 25]]), w: 0.6 },
  ];
  const bits: string[] = [];
  if (posFrac !== null) bits.push(`${Math.round(posFrac * 100)}% de anos con beneficio`);
  if (beatFrac !== null) bits.push(`${Math.round(beatFrac * 100)}% de trimestres batiendo`);
  if (shTrend !== null) bits.push(shTrend < 0 ? `recompras ${shTrend}% de acciones` : shTrend > 0 ? `dilucion +${shTrend}%` : "acciones estables");
  const score = weightedAvg(parts);
  return {
    key: "consistency",
    label: FACTOR_LABEL.consistency,
    score: score === null ? null : round(score),
    weight: WEIGHTS.consistency,
    detail: bits.length ? bits.join(", ") : "sin historico suficiente",
  };
}

// ---------------------------------------------------------------------------
// Valor razonable (heuristica transparente)

/**
 * Valor razonable por accion. PER justificado = PER sin crecimiento (inverso
 * del retorno exigido: bono + prima de riesgo) mas una prima por crecimiento,
 * acotado. Es una estimacion, no un precio objetivo garantizado.
 */
export const EQUITY_RISK_PREMIUM = 4.5;
export const PEG_PREMIUM_K = 1.0;
export const PE_FLOOR = 8;
export const PE_CEIL = 35;

export type FairValueDetail = {
  value: number | null;
  justifiedPe: number | null;
  range: DcfRange | null;
  method: "dcf" | "pe" | null;
  discountPct: number | null;
  impliedGrowthPct: number | null;
};

const NO_FAIR: FairValueDetail = {
  value: null,
  justifiedPe: null,
  range: null,
  method: null,
  discountPct: null,
  impliedGrowthPct: null,
};

/**
 * Valor razonable por accion. Preferencia: DCF sobre FCF (caja real, tres
 * escenarios, mas el crecimiento implicito en el precio). Si no hay FCF,
 * respaldo por PER justificado sobre beneficios. En pico de ciclo se toma el
 * escenario bajista: valorar sobre beneficios de pico es la trampa clasica.
 */
export function fairValue(input: ConvictionInput): FairValueDetail {
  if (input.assetClass !== "equity") return NO_FAIR;
  const price = input.price;
  if (!isFin(price) || price <= 0) return NO_FAIR;
  const growth = growthEstimate(input) ?? 0;

  const fps = fcfPerShare(input.financials);
  if (isFin(fps) && fps > 0) {
    const discountPct = discountRate(input.riskFreeRate, input.fundamentals?.beta ?? null);
    const range = dcfRange({ fcfPerShare: fps, growthPct: growth, discountPct });
    if (range) {
      const peak = peakCycle(input).flagged;
      return {
        value: peak ? range.bear : range.base,
        justifiedPe: null,
        range,
        method: "dcf",
        discountPct,
        impliedGrowthPct: reverseDcf(price, { fcfPerShare: fps, discountPct }),
      };
    }
  }

  // Respaldo: PER justificado. Beneficios TTM distorsionados -> sin valor.
  if (!earningsReliable(input.fundamentals)) return NO_FAIR;
  const pe = input.fundamentals?.pe ?? null;
  // BPA TTM: si hay PER y precio, es precio/PER; si no, ultimo BPA anual EDGAR.
  const epsTtm = isFin(pe) && pe > 0 ? price / pe : input.financials?.years.at(-1)?.eps ?? null;
  if (!isFin(epsTtm) || epsTtm <= 0) return NO_FAIR;
  const required = (isFin(input.riskFreeRate) ? input.riskFreeRate : 4.0) + EQUITY_RISK_PREMIUM;
  const noGrowthPe = 100 / required;
  const justifiedPe = Math.max(PE_FLOOR, Math.min(PE_CEIL, noGrowthPe + Math.max(0, growth) * PEG_PREMIUM_K));
  return {
    value: round(epsTtm * justifiedPe, 2),
    justifiedPe: round(justifiedPe, 1),
    range: null,
    method: "pe",
    discountPct: null,
    impliedGrowthPct: null,
  };
}

// ---------------------------------------------------------------------------
// Veredicto

/** Umbrales de puntuacion -> postura para un candidato (sin posicion). */
export const BANDS: Array<[number, Posture]> = [
  [78, "strong_buy"],
  [64, "buy"],
  [46, "hold"],
  [33, "avoid"],
  [0, "avoid"],
];

function candidatePosture(score: number): Posture {
  for (const [min, p] of BANDS) if (score >= min) return p;
  return "avoid";
}

/**
 * Postura para una posicion ya en cartera. La misma calidad, pero con la capa
 * de venta: sobrevaloracion (precio muy por encima del valor razonable) o
 * deterioro (puntuacion baja) piden reducir o vender aunque el negocio sea
 * bueno. Esto es el lado "que vender".
 */
function heldPosture(score: number, upsidePct: number | null): Posture {
  if (score < 30) return "sell";
  if (score < 42) return "reduce";
  // Buen negocio pero caro: recoger.
  if (isFin(upsidePct) && upsidePct < -30) return "reduce";
  if (score >= 72 && (upsidePct === null || upsidePct > -10)) return "buy";
  if (score >= 60) return "hold";
  if (isFin(upsidePct) && upsidePct < -15) return "reduce";
  return "hold";
}

function buildRationale(
  factors: Factor[],
  fv: FairValueDetail,
  upsidePct: number | null,
  growth: number | null,
): string {
  const scored = factors.filter((f) => f.score !== null) as Array<Factor & { score: number }>;
  if (scored.length === 0) return "Sin fundamentales suficientes para un veredicto.";
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const best = sorted.slice(0, 2).filter((f) => f.score >= 55);
  const worst = sorted[sorted.length - 1];
  const parts: string[] = [];
  if (best.length) parts.push(`${best.map((f) => `${f.label.toLowerCase()} (${f.detail})`).join("; ")}`);
  if (worst && worst.score < 50) parts.push(`pero flojo en ${worst.label.toLowerCase()} (${worst.detail})`);
  if (isFin(upsidePct) && fv.value !== null) {
    const how = fv.method === "dcf" ? "al valor razonable (DCF sobre FCF)" : "al valor razonable";
    parts.push(
      upsidePct >= 0
        ? `potencial ~+${round(upsidePct)}% ${how}`
        : `cotiza ~${round(Math.abs(upsidePct))}% por encima del valor razonable`,
    );
  }
  // El DCF inverso en una frase: lo que el precio ya descuenta vs lo realista.
  if (isFin(fv.impliedGrowthPct)) {
    const g = fv.impliedGrowthPct;
    const vs = isFin(growth) ? ` frente a ~${round(growth)}% estimado` : "";
    parts.push(
      g >= 100
        ? `el precio descuenta un crecimiento de FCF dificil de justificar (>100%/ano)${vs}`
        : `el precio descuenta ~${round(g)}%/ano de crecimiento de FCF${vs}`,
    );
  }
  return parts.join(". ") + ".";
}

function buildInvalidation(input: ConvictionInput, fv: FairValueDetail): string | null {
  const f = input.fundamentals;
  const netMargin = f?.netMargin ?? input.financials?.years.at(-1)?.netMargin ?? null;
  const last = input.financials?.years.at(-1);
  const bits: string[] = [];
  if (isFin(netMargin)) {
    bits.push(`si el margen neto cae de ~${round(netMargin * 0.75)}% o el crecimiento de ingresos se vuelve negativo`);
  } else {
    bits.push("si el crecimiento de ingresos se vuelve negativo dos trimestres seguidos");
  }
  if (isFin(last?.fcf) && last.fcf > 0) bits.push("si el FCF anual pasa a negativo");
  if (fv.range) bits.push(`nivel a vigilar: escenario bajista ~${round(fv.range.bear)}`);
  else if (isFin(f?.low52)) bits.push(`nivel a vigilar: minimo de 52s ~${round(f.low52)}`);
  else if (fv.value !== null) bits.push(`nivel a vigilar: por debajo de ~${round(fv.value * 0.7)}`);
  return bits.length ? `Se debilita ${bits.join("; ")}.` : null;
}

/**
 * Evalua un activo y devuelve el veredicto completo. Puro y determinista.
 */
export function evaluate(input: ConvictionInput, now = Date.now()): ConvictionResult {
  const name = input.name ?? null;
  const held = Boolean(input.position);

  // Cripto y clases sin fundamentales: fuera del alcance de este motor.
  const hasAny = Boolean(input.fundamentals) || Boolean(input.financials?.available);
  if (input.assetClass === "crypto" || !hasAny) {
    return {
      symbol: input.symbol,
      name,
      held,
      posture: "no_coverage",
      score: 0,
      confidence: 0,
      dataQuality: "insufficient",
      factors: [],
      fairValue: null,
      fairRange: null,
      valuationMethod: null,
      impliedGrowthPct: null,
      marginOfSafetyPct: null,
      upsidePct: null,
      rationale:
        input.assetClass === "crypto"
          ? "Cripto: sin estados financieros, fuera del analisis fundamental."
          : "Sin fundamentales disponibles para este activo.",
      invalidation: null,
      caveats: [],
      asOf: now,
    };
  }

  const factors: Factor[] = [
    scoreValuation(input),
    scoreGrowth(input),
    scoreQuality(input),
    scoreStrength(input),
    scoreConsistency(input),
  ];

  const present = factors.filter((f) => f.score !== null);
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const presentWeight = present.reduce((s, f) => s + f.weight, 0);
  const composite =
    presentWeight > 0
      ? present.reduce((s, f) => s + (f.score as number) * f.weight, 0) / presentWeight
      : 0;
  const score = round(composite);
  const confidence = round(presentWeight / totalWeight, 2);

  const fv = fairValue(input);
  const upsidePct =
    fv.value !== null && isFin(input.price) && input.price > 0
      ? round((fv.value / input.price - 1) * 100)
      : null;

  const dataQuality: ConvictionResult["dataQuality"] =
    present.length >= 4 ? "full" : present.length >= 2 ? "partial" : "insufficient";

  let posture: Posture;
  if (dataQuality === "insufficient") {
    posture = "no_coverage";
  } else if (held) {
    posture = heldPosture(score, upsidePct);
  } else {
    posture = candidatePosture(score);
  }

  const caveats: string[] = [];
  if (!earningsReliable(input.fundamentals)) {
    caveats.push(
      fv.method === "dcf"
        ? "Beneficios TTM posiblemente distorsionados (margen neto > bruto); el valor razonable se apoya en el FCF, no en el BPA."
        : "Beneficios TTM posiblemente distorsionados (margen neto > bruto); valor razonable omitido.",
    );
  }
  const peak = peakCycle(input);
  if (peak.flagged) {
    caveats.push(
      `Posible pico de ciclo: margen ${peak.current}% frente a una mediana historica de ${peak.median}%; valoracion recortada y valor razonable en escenario bajista.`,
    );
  }
  const conv = cashConversion(input.financials);
  if (isFin(conv) && conv < 0.7) {
    caveats.push(`Solo ${Math.round(conv * 100)}% del beneficio se convierte en caja operativa.`);
  }
  if (dataQuality === "partial") caveats.push("Cobertura parcial: faltan fundamentales.");
  if (input.assetClass === "equity" && !input.financials?.available) {
    caveats.push("Sin historico EDGAR (10-K); solo datos TTM.");
  }

  return {
    symbol: input.symbol,
    name,
    held,
    posture,
    score,
    confidence,
    dataQuality,
    factors,
    fairValue: fv.value,
    fairRange: fv.range,
    valuationMethod: fv.method,
    impliedGrowthPct: fv.impliedGrowthPct,
    marginOfSafetyPct: marginOfSafety(fv.value, input.price),
    upsidePct,
    rationale: buildRationale(factors, fv, upsidePct, growthEstimate(input)),
    invalidation: buildInvalidation(input, fv),
    caveats,
    asOf: now,
  };
}

/** Ordena veredictos por accionabilidad: primero lo mas "comprar", luego score. */
export function rankResults(results: ConvictionResult[]): ConvictionResult[] {
  return [...results].sort((a, b) => {
    const pr = POSTURE_RANK[b.posture] - POSTURE_RANK[a.posture];
    if (pr !== 0) return pr;
    return b.score - a.score;
  });
}
