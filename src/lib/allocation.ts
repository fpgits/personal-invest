import type { ConvictionResult } from "./conviction";
import type { Posture } from "./conviction-labels";

/**
 * Asignacion mensual de capital: reparte el efectivo nuevo entre las ideas
 * que el motor de conviccion marca como compra, en proporcion a su atractivo
 * (conviccion inclinada por margen de seguridad) y a lo lejos que estan de su
 * peso objetivo, respetando el peso maximo por posicion y un ticket minimo. Lo
 * que no encuentra destino va a la reserva (p. ej. SGOV): un plan que a veces
 * dice "este mes no compres nada caro" es un plan del que fiarse.
 *
 * Puro y determinista. No opera: produce un plan en dolares con la razon de
 * cada linea para que el inversor lo ejecute (o no) por fuera.
 */

export type AllocationSettings = {
  /** Peso maximo por posicion tras el aporte, en % del total. */
  maxWeightPct: number;
  /** Ticket minimo por linea; por debajo no se compra (evita migajas). */
  minTicket: number;
  /** Puntuacion minima para recibir dinero nuevo. */
  buyThreshold: number;
  /** Donde aparcar lo que no se asigna (p. ej. SGOV); null = efectivo. */
  reserveSymbol: string | null;
  /** Redondeo de importes en dolares (10 = a la decena). */
  roundTo?: number;
};

export const DEFAULT_ALLOCATION: AllocationSettings = {
  maxWeightPct: 15,
  minTicket: 500,
  buyThreshold: 64,
  reserveSymbol: "SGOV",
  roundTo: 10,
};

export type Holding = { symbol: string; value: number };

export type PlanLine = {
  symbol: string;
  amount: number;
  score: number;
  posture: Posture;
  marginOfSafetyPct: number | null;
  weightBefore: number;
  weightAfter: number;
  reason: string;
};

export type PlanNote = { symbol: string; posture: Posture; reason: string };

export type Plan = {
  cash: number;
  totalBefore: number;
  totalAfter: number;
  lines: PlanLine[];
  reserve: number;
  reserveSymbol: string | null;
  reserveReason: string | null;
  /** Posiciones que el motor pide recortar o vender. */
  trims: PlanNote[];
  /** Lo que no recibe dinero nuevo y por que. */
  skipped: PlanNote[];
};

const BUY_POSTURES: Posture[] = ["strong_buy", "buy"];
const TRIM_POSTURES: Posture[] = ["reduce", "sell"];

/** Atractivo: conviccion inclinada por margen de seguridad (acotado). */
export function attractiveness(score: number, marginOfSafetyPct: number | null): number {
  const mos = Math.max(-30, Math.min(50, marginOfSafetyPct ?? 0));
  return score + 0.4 * mos;
}

/**
 * Pesos objetivo proporcionales al atractivo, con tope por posicion y
 * redistribucion del exceso entre las que no han tocado el tope.
 */
export function targetWeights(items: Array<{ symbol: string; a: number }>, maxWeightPct: number): Map<string, number> {
  const out = new Map<string, number>();
  const pos = items.filter((i) => i.a > 0);
  if (pos.length === 0) return out;
  const total = pos.reduce((s, i) => s + i.a, 0);
  for (const i of pos) out.set(i.symbol, (i.a / total) * 100);
  // Water-filling: recorta al tope y reparte el sobrante entre las libres.
  for (let iter = 0; iter < 10; iter++) {
    let excess = 0;
    const free: string[] = [];
    for (const [s, w] of out) {
      if (w > maxWeightPct) {
        excess += w - maxWeightPct;
        out.set(s, maxWeightPct);
      } else if (w < maxWeightPct) {
        free.push(s);
      }
    }
    if (excess < 1e-9 || free.length === 0) break;
    const freeTotal = free.reduce((s, k) => s + (out.get(k) as number), 0);
    for (const k of free) {
      const w = out.get(k) as number;
      out.set(k, w + (freeTotal > 0 ? (excess * w) / freeTotal : excess / free.length));
    }
  }
  return out;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

export function allocate(args: {
  cash: number;
  holdings: Holding[];
  verdicts: ConvictionResult[];
  settings?: Partial<AllocationSettings>;
}): Plan {
  const settings: AllocationSettings = { ...DEFAULT_ALLOCATION, ...(args.settings ?? {}) };
  const step = settings.roundTo && settings.roundTo > 0 ? settings.roundTo : 10;
  const cash = Math.max(0, roundTo(args.cash, step));
  const valueOf = new Map(args.holdings.map((h) => [h.symbol, Math.max(0, h.value)]));
  const totalBefore = args.holdings.reduce((s, h) => s + Math.max(0, h.value), 0);
  const totalAfter = totalBefore + cash;
  const wBefore = (s: string) => (totalBefore > 0 ? ((valueOf.get(s) ?? 0) / totalBefore) * 100 : 0);

  const trims: PlanNote[] = [];
  const skipped: PlanNote[] = [];
  const empty = (reserveReason: string | null): Plan => ({
    cash,
    totalBefore,
    totalAfter,
    lines: [],
    reserve: cash,
    reserveSymbol: settings.reserveSymbol,
    reserveReason,
    trims,
    skipped,
  });

  for (const v of args.verdicts) {
    if (TRIM_POSTURES.includes(v.posture)) trims.push({ symbol: v.symbol, posture: v.posture, reason: v.rationale });
  }
  if (cash <= 0) return empty(null);

  // Candidatas: compra con conviccion suficiente y datos suficientes.
  const candidates = args.verdicts.filter(
    (v) =>
      BUY_POSTURES.includes(v.posture) &&
      v.score >= settings.buyThreshold &&
      v.dataQuality !== "insufficient" &&
      v.symbol !== settings.reserveSymbol,
  );
  for (const v of args.verdicts) {
    if (candidates.includes(v) || TRIM_POSTURES.includes(v.posture)) continue;
    if (v.posture === "no_coverage") skipped.push({ symbol: v.symbol, posture: v.posture, reason: "sin cobertura fundamental" });
    else if (v.posture === "hold") skipped.push({ symbol: v.symbol, posture: v.posture, reason: "mantener: solido pero sin margen claro para dinero nuevo" });
    else if (BUY_POSTURES.includes(v.posture)) skipped.push({ symbol: v.symbol, posture: v.posture, reason: `por debajo del umbral de compra (${settings.buyThreshold})` });
    else skipped.push({ symbol: v.symbol, posture: v.posture, reason: "evitar" });
  }
  if (candidates.length === 0) {
    return empty(`Nada supera el umbral de compra (${settings.buyThreshold}): mejor esperar con la reserva.`);
  }

  // Hueco hasta el tope por posicion (en dolares) para cada candidata.
  const cap = (settings.maxWeightPct / 100) * totalAfter;
  const room = new Map(candidates.map((v) => [v.symbol, Math.max(0, cap - (valueOf.get(v.symbol) ?? 0))]));
  const attract = new Map(candidates.map((v) => [v.symbol, attractiveness(v.score, v.marginOfSafetyPct)]));

  // Reparto iterativo: pesos objetivo sobre las candidatas activas, hueco
  // hasta ese objetivo (acotado por el tope), y proporcional al hueco. Las
  // que no llegan al ticket minimo salen y se recalcula sobre las demas.
  let active = candidates.map((v) => v.symbol);
  let amounts = new Map<string, number>();
  const dropTiny = (s: string) => {
    skipped.push({ symbol: s, posture: "buy", reason: `ticket por debajo del minimo (${settings.minTicket})` });
  };
  for (let iter = 0; iter < 10 && active.length > 0; iter++) {
    const targets = targetWeights(
      active.map((s) => ({ symbol: s, a: attract.get(s) ?? 0 })),
      settings.maxWeightPct,
    );
    const gaps = new Map<string, number>();
    const full: string[] = [];
    for (const s of active) {
      const target = ((targets.get(s) ?? 0) / 100) * totalAfter;
      const gap = Math.max(0, Math.min(target - (valueOf.get(s) ?? 0), room.get(s) ?? 0));
      if (gap <= 0) full.push(s);
      else gaps.set(s, gap);
    }
    if (full.length > 0) {
      for (const s of full) {
        const v = bySymbolOf(candidates, s);
        skipped.push({ symbol: s, posture: v?.posture ?? "buy", reason: "ya en su peso objetivo o en el tope por posicion" });
      }
      active = active.filter((s) => !full.includes(s));
      continue;
    }
    const gapSum = [...gaps.values()].reduce((s, g) => s + g, 0);
    if (gapSum <= 0) break;
    const scale = Math.min(1, cash / gapSum);
    amounts = new Map([...gaps].map(([s, g]) => [s, g * scale]));
    const tiny = [...amounts].filter(([, a]) => a < settings.minTicket).map(([s]) => s);
    if (tiny.length === 0) break;
    if (tiny.length === amounts.size) {
      // Ni repartiendo llega al ticket: concentrar en la mas atractiva, hasta su hueco.
      const best = [...active].sort((a, b) => (attract.get(b) ?? 0) - (attract.get(a) ?? 0))[0];
      const single = Math.min(cash, room.get(best) ?? 0);
      amounts = single >= settings.minTicket ? new Map([[best, single]]) : new Map();
      for (const s of active) if (!amounts.has(s)) dropTiny(s);
      break;
    }
    for (const s of tiny) dropTiny(s);
    active = active.filter((s) => !tiny.includes(s));
    amounts = new Map();
  }

  // Redondeo y cuadre exacto: la diferencia se ajusta en la linea mayor.
  const rounded = new Map([...amounts].map(([s, a]) => [s, roundTo(a, step)]));
  let sum = [...rounded.values()].reduce((s, a) => s + a, 0);
  if (sum > cash && rounded.size > 0) {
    const big = [...rounded].sort((a, b) => b[1] - a[1])[0][0];
    rounded.set(big, (rounded.get(big) as number) - (sum - cash));
    sum = cash;
  }
  const reserve = Math.max(0, cash - sum);

  const bySymbol = new Map(candidates.map((v) => [v.symbol, v]));
  const lines: PlanLine[] = [...rounded]
    .filter(([, a]) => a > 0)
    .map(([symbol, amount]) => {
      const v = bySymbol.get(symbol) as ConvictionResult;
      const before = wBefore(symbol);
      const after = totalAfter > 0 ? (((valueOf.get(symbol) ?? 0) + amount) / totalAfter) * 100 : 0;
      const mos = v.marginOfSafetyPct;
      const reason = [
        `conviccion ${v.score}`,
        mos !== null ? `margen de seguridad ${mos > 0 ? "+" : ""}${mos}%` : null,
        `peso ${before.toFixed(1)}% → ${after.toFixed(1)}%`,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        symbol,
        amount,
        score: v.score,
        posture: v.posture,
        marginOfSafetyPct: mos,
        weightBefore: round1(before),
        weightAfter: round1(after),
        reason,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  let reserveReason: string | null = null;
  if (reserve > 0 && lines.length === 0) reserveReason = "Ninguna candidata admite un ticket minimo: reserva.";
  else if (reserve > 0) reserveReason = "Las candidatas ya llegan a su peso objetivo: el resto a reserva.";

  return {
    cash,
    totalBefore,
    totalAfter,
    lines,
    reserve,
    reserveSymbol: settings.reserveSymbol,
    reserveReason,
    trims,
    skipped,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function bySymbolOf(list: ConvictionResult[], symbol: string): ConvictionResult | undefined {
  return list.find((v) => v.symbol === symbol);
}
