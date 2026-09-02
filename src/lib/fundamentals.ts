import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, fundamentals, type Asset, type Fundamentals } from "@/db/schema";
import { finnhub } from "./market";
import type { EarningsQuarter, FundamentalMetrics } from "./market/finnhub";
import { batched } from "./utils";

/**
 * Fundamentales basicos por accion (Finnhub, plan free): ratios TTM,
 * ultimos trimestres frente a estimacion y proxima fecha de resultados.
 *
 * No es un modelo financiero: es el minimo para que la tesis tenga numeros
 * contra los que contrastar supuestos y para que el motor de eventos sepa,
 * por ejemplo, que "supera estimaciones" llega con margenes cayendo.
 */
export const FUNDAMENTALS_TTL_MS = 7 * 86400_000;

export type FundamentalsView = {
  metrics: FundamentalMetrics;
  earnings: EarningsQuarter[];
  nextEarningsAt: number | null;
  updatedAt: number;
};

const EMPTY_METRICS: FundamentalMetrics = {
  marketCap: null, pe: null, ps: null, pb: null, beta: null,
  revenueGrowthYoy: null, epsGrowthYoy: null, grossMargin: null,
  operatingMargin: null, netMargin: null, roe: null, debtToEquity: null,
  currentRatio: null, dividendYield: null, high52: null, low52: null,
};

export function parseFundamentals(row: Fundamentals | undefined | null): FundamentalsView | null {
  if (!row) return null;
  return {
    metrics: { ...EMPTY_METRICS, ...safeJson<Partial<FundamentalMetrics>>(row.metrics, {}) },
    earnings: safeJson<EarningsQuarter[]>(row.earnings, []),
    nextEarningsAt: row.nextEarningsAt,
    updatedAt: row.updatedAt,
  };
}

/** Solo acciones: los ETF y las cripto no tienen resultados trimestrales. */
function eligible(a: Pick<Asset, "assetClass">) {
  return a.assetClass === "equity";
}

export async function refreshFundamentals(
  targets?: Asset[],
  opts: { force?: boolean } = {},
): Promise<{ updated: number; skipped: number }> {
  const all = targets ?? (await db.select().from(assets));
  const wanted = all.filter(eligible);
  if (wanted.length === 0) return { updated: 0, skipped: 0 };

  const existing = await db
    .select()
    .from(fundamentals)
    .where(inArray(fundamentals.assetId, wanted.map((a) => a.id)));
  const fresh = new Set(
    existing
      .filter((f) => Date.now() - f.updatedAt < FUNDAMENTALS_TTL_MS)
      .map((f) => f.assetId),
  );
  const todo = opts.force ? wanted : wanted.filter((a) => !fresh.has(a.id));

  let updated = 0;
  // Tres llamadas por activo; Finnhub free admite 60/min.
  await batched(
    todo,
    4,
    async (a) => {
      const symbol = a.providerId || a.symbol;
      const [metrics, earnings, nextAt] = await Promise.all([
        finnhub.metrics(symbol),
        finnhub.earnings(symbol),
        finnhub.nextEarnings(symbol),
      ]);
      if (!metrics && earnings.length === 0 && nextAt === null) return;
      await db
        .insert(fundamentals)
        .values({
          assetId: a.id,
          metrics: JSON.stringify(metrics ?? {}),
          earnings: JSON.stringify(earnings),
          nextEarningsAt: nextAt,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: fundamentals.assetId,
          set: {
            metrics: JSON.stringify(metrics ?? {}),
            earnings: JSON.stringify(earnings),
            nextEarningsAt: nextAt,
            updatedAt: Date.now(),
          },
        });
      updated++;
    },
    1100,
  );

  return { updated, skipped: wanted.length - todo.length };
}

export async function getFundamentals(assetId: string): Promise<FundamentalsView | null> {
  const rows = await db.select().from(fundamentals).where(eq(fundamentals.assetId, assetId)).limit(1);
  return parseFundamentals(rows[0]);
}

export async function getFundamentalsMap(assetIds: string[]): Promise<Map<string, FundamentalsView>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.select().from(fundamentals).where(inArray(fundamentals.assetId, assetIds));
  return new Map(rows.map((r) => [r.assetId, parseFundamentals(r)!]));
}

/**
 * Una linea compacta para prompts. Solo lo que existe; nunca inventa un
 * numero que Finnhub no dio.
 */
export function fundamentalsToText(f: FundamentalsView | null | undefined): string {
  if (!f) return "";
  const m = f.metrics;
  const parts: string[] = [];
  const pct = (v: number | null, label: string) => {
    if (v !== null) parts.push(`${label} ${v.toFixed(1)}%`);
  };
  const num = (v: number | null, label: string, digits = 1) => {
    if (v !== null) parts.push(`${label} ${v.toFixed(digits)}`);
  };
  if (m.marketCap !== null) parts.push(`cap. ${fmtCap(m.marketCap)}`);
  num(m.pe, "P/E");
  num(m.ps, "P/S");
  num(m.pb, "P/B");
  pct(m.revenueGrowthYoy, "crec. ingresos");
  pct(m.epsGrowthYoy, "crec. BPA");
  pct(m.grossMargin, "margen bruto");
  pct(m.operatingMargin, "margen operativo");
  pct(m.netMargin, "margen neto");
  pct(m.roe, "ROE");
  num(m.debtToEquity, "deuda/equity", 2);
  num(m.currentRatio, "ratio corriente", 2);
  pct(m.dividendYield, "div. yield");
  if (m.high52 !== null && m.low52 !== null) parts.push(`rango 52s ${m.low52}-${m.high52}`);

  const q = f.earnings.slice(0, 4).map((e) => {
    const s = e.surprisePct !== null ? ` (${e.surprisePct > 0 ? "+" : ""}${e.surprisePct.toFixed(1)}% vs est.)` : "";
    return `${e.period}: BPA ${e.actual ?? "?"}${s}`;
  });
  const next = f.nextEarningsAt ? `proximos resultados ${new Date(f.nextEarningsAt).toISOString().slice(0, 10)}` : "";
  const asOf = `datos de ${new Date(f.updatedAt).toISOString().slice(0, 10)}`;

  return [parts.join(", "), q.length ? `trimestres: ${q.join("; ")}` : "", next, asOf]
    .filter(Boolean)
    .join(". ");
}

function fmtCap(millions: number): string {
  if (millions >= 1_000_000) return `${(millions / 1_000_000).toFixed(2)}T`;
  if (millions >= 1_000) return `${(millions / 1_000).toFixed(1)}B`;
  return `${millions.toFixed(0)}M`;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
