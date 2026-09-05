import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { assets, convictionCalls, priceCache, type ConvictionCall } from "@/db/schema";
import type { ConvictionResult } from "./conviction";
import type { Posture } from "./conviction-labels";
import { id } from "./utils";

/**
 * Registro y medicion de las llamadas del oraculo. Cada veredicto y cada
 * linea de plan se guarda con su precio; el job nocturno rellena el retorno
 * a 30/90/180/365 dias con el precio en cache del momento en que se cumple
 * el plazo. Con eso se mide tasa de acierto por postura, retorno medio, y
 * como lo habria hecho el indice (fila `benchmark`) en el mismo periodo.
 */

export const HORIZONS = [30, 90, 180, 365] as const;
export type Horizon = (typeof HORIZONS)[number];
const DAY = 86400_000;

export type CallItem = {
  result: ConvictionResult;
  assetId: string | null;
  assetClass: string;
  price: number | null;
  planAmount?: number | null;
};

export type Benchmark = { symbol: string; assetId: string | null; price: number | null };

/** Guarda una corrida completa. Devuelve el id del lote. */
export async function recordBatch(args: {
  kind: "verdict" | "plan";
  items: CallItem[];
  benchmark?: Benchmark | null;
  now?: number;
}): Promise<string> {
  const now = args.now ?? Date.now();
  const batchId = id();
  const rows: (typeof convictionCalls.$inferInsert)[] = args.items.map(({ result: r, assetId, assetClass, price, planAmount }) => ({
    id: id(),
    batchId,
    kind: args.kind as string,
    assetId,
    symbol: r.symbol,
    assetClass,
    posture: r.posture,
    score: r.score,
    confidence: r.confidence,
    price,
    fairValue: r.fairValue,
    upsidePct: r.upsidePct,
    marginOfSafetyPct: r.marginOfSafetyPct,
    planAmount: planAmount ?? null,
    rationale: r.rationale,
    calledAt: now,
  }));
  if (args.benchmark && args.benchmark.price !== null) {
    rows.push({
      id: id(),
      batchId,
      kind: "benchmark" as const,
      assetId: args.benchmark.assetId,
      symbol: args.benchmark.symbol,
      assetClass: "equity",
      posture: "hold",
      score: 0,
      confidence: 0,
      price: args.benchmark.price,
      fairValue: null,
      upsidePct: null,
      marginOfSafetyPct: null,
      planAmount: null,
      rationale: "indice de referencia",
      calledAt: now,
    });
  }
  if (rows.length > 0) await db.insert(convictionCalls).values(rows);
  return batchId;
}

/**
 * Rellena los retornos vencidos con el precio actual en cache. Idempotente:
 * solo toca horizontes ya cumplidos que sigan en null. Devuelve cuantas
 * filas se actualizaron.
 */
export async function markForwardReturns(now = Date.now()): Promise<number> {
  const due = await db
    .select()
    .from(convictionCalls)
    .where(
      and(
        lte(convictionCalls.calledAt, now - 30 * DAY),
        or(
          isNull(convictionCalls.ret30),
          isNull(convictionCalls.ret90),
          isNull(convictionCalls.ret180),
          isNull(convictionCalls.ret365),
        ),
      ),
    );
  if (due.length === 0) return 0;

  const ids = [...new Set(due.map((d) => d.assetId).filter((x): x is string => Boolean(x)))];
  const prices = new Map<string, number>();
  if (ids.length > 0) {
    const rows = await db.select().from(priceCache).where(inArray(priceCache.assetId, ids));
    for (const r of rows) prices.set(r.assetId, r.price);
  }
  // Sin asset_id (o sin precio por id): buscar por simbolo.
  const missing = due.filter((d) => !(d.assetId && prices.has(d.assetId)));
  const symbolPrice = new Map<string, number>();
  if (missing.length > 0) {
    const syms = [...new Set(missing.map((m) => m.symbol))];
    const rows = await db
      .select({ symbol: assets.symbol, assetClass: assets.assetClass, price: priceCache.price })
      .from(priceCache)
      .innerJoin(assets, eq(priceCache.assetId, assets.id))
      .where(inArray(assets.symbol, syms));
    for (const r of rows) if (r.assetClass !== "crypto" || !symbolPrice.has(r.symbol)) symbolPrice.set(r.symbol, r.price);
  }

  let updated = 0;
  for (const call of due) {
    if (call.price === null || call.price <= 0) continue;
    const byId = call.assetId ? prices.get(call.assetId) : undefined;
    const current: number | null = byId ?? symbolPrice.get(call.symbol) ?? null;
    if (current === null) continue;
    const age = now - call.calledAt;
    const ret = round((current / call.price - 1) * 100);
    const patch: Partial<ConvictionCall> = {};
    if (call.ret30 === null && age >= 30 * DAY) patch.ret30 = ret;
    if (call.ret90 === null && age >= 90 * DAY) patch.ret90 = ret;
    if (call.ret180 === null && age >= 180 * DAY) patch.ret180 = ret;
    if (call.ret365 === null && age >= 365 * DAY) patch.ret365 = ret;
    if (Object.keys(patch).length === 0) continue;
    patch.markedAt = now;
    await db.update(convictionCalls).set(patch).where(eq(convictionCalls.id, call.id));
    updated++;
  }
  return updated;
}

export async function listCalls(limit = 200): Promise<ConvictionCall[]> {
  return db.select().from(convictionCalls).orderBy(desc(convictionCalls.calledAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Estadisticas (puras sobre filas, para poder testearlas)

export type PostureStats = {
  posture: Posture | "benchmark";
  n: number;
  /** Retorno medio por horizonte (%), null si no hay filas vencidas. */
  avg: Record<Horizon, number | null>;
  /** Filas vencidas por horizonte. */
  counts: Record<Horizon, number>;
  /**
   * Tasa de acierto por horizonte: para compras, retorno > 0; para recortes y
   * ventas, retorno < 0 (acertar es que cayera). null si no aplica.
   */
  hitRate: Record<Horizon, number | null>;
};

const BUY: Posture[] = ["strong_buy", "buy"];
const SELL: Posture[] = ["reduce", "sell", "avoid"];

export function summarizeCalls(rows: ConvictionCall[]): PostureStats[] {
  const groups = new Map<string, ConvictionCall[]>();
  for (const r of rows) {
    const key = r.kind === "benchmark" ? "benchmark" : r.posture;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: PostureStats[] = [];
  for (const [key, list] of groups) {
    const avg = {} as Record<Horizon, number | null>;
    const counts = {} as Record<Horizon, number>;
    const hitRate = {} as Record<Horizon, number | null>;
    for (const h of HORIZONS) {
      const vals = list.map((r) => retAt(r, h)).filter((v): v is number => v !== null);
      counts[h] = vals.length;
      avg[h] = vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
      if (key === "benchmark" || key === "hold" || key === "no_coverage" || vals.length === 0) {
        hitRate[h] = null;
      } else if (BUY.includes(key as Posture)) {
        hitRate[h] = round((vals.filter((v) => v > 0).length / vals.length) * 100);
      } else if (SELL.includes(key as Posture)) {
        hitRate[h] = round((vals.filter((v) => v < 0).length / vals.length) * 100);
      } else {
        hitRate[h] = null;
      }
    }
    out.push({ posture: key as PostureStats["posture"], n: list.length, avg, counts, hitRate });
  }
  const order = ["strong_buy", "buy", "hold", "reduce", "sell", "avoid", "no_coverage", "benchmark"];
  return out.sort((a, b) => order.indexOf(a.posture) - order.indexOf(b.posture));
}

function retAt(r: ConvictionCall, h: Horizon): number | null {
  switch (h) {
    case 30:
      return r.ret30;
    case 90:
      return r.ret90;
    case 180:
      return r.ret180;
    case 365:
      return r.ret365;
  }
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
