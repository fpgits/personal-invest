import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { env } from "./env";

/**
 * Ajustes editables en caliente. Lo que este aqui pisa al env,
 * para poder cambiar de modelo sin redeploy.
 */
export const SETTING_KEYS = {
  modelAnalysis: "model_analysis",
  modelFast: "model_fast",
  baseCurrency: "base_currency",
  costMethod: "cost_method", // average | fifo
  /** USD al dia para las llamadas de fondo (crons). 0 = sin limite. */
  aiDailyBudget: "ai_daily_budget_usd",
  // Oraculo: parametros del plan mensual. Se editan en Ajustes.
  oracleMonthlyEquity: "oracle_monthly_equity",
  oracleMonthlyCrypto: "oracle_monthly_crypto",
  oracleMaxWeightPct: "oracle_max_weight_pct",
  oracleMinTicket: "oracle_min_ticket",
  oracleBuyThreshold: "oracle_buy_threshold",
  oracleReserveSymbol: "oracle_reserve_symbol",
  oracleCryptoCore: "oracle_crypto_core",
  oracleContributionDay: "oracle_contribution_day",
} as const;

export type OracleSettings = {
  monthlyEquity: number;
  monthlyCrypto: number;
  maxWeightPct: number;
  minTicket: number;
  buyThreshold: number;
  reserveSymbol: string | null;
  /** "BTC:60,ETH:40" */
  cryptoCore: string;
  contributionDay: number;
};

export const ORACLE_DEFAULTS: OracleSettings = {
  monthlyEquity: 4000,
  monthlyCrypto: 2500,
  maxWeightPct: 15,
  minTicket: 500,
  buyThreshold: 64,
  reserveSymbol: "SGOV",
  cryptoCore: "BTC:60,ETH:40",
  contributionDay: 1,
};

/** Parametros del oraculo con valores por defecto sensatos. Puro sobre el mapa de ajustes. */
export function oracleFromSettings(all: Record<string, string>): OracleSettings {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(all[key]);
    return all[key] !== undefined && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  };
  const rawReserve = all[SETTING_KEYS.oracleReserveSymbol];
  const reserve = (rawReserve === undefined ? ORACLE_DEFAULTS.reserveSymbol ?? "" : rawReserve).trim().toUpperCase();
  return {
    monthlyEquity: num(SETTING_KEYS.oracleMonthlyEquity, ORACLE_DEFAULTS.monthlyEquity, 0, 10_000_000),
    monthlyCrypto: num(SETTING_KEYS.oracleMonthlyCrypto, ORACLE_DEFAULTS.monthlyCrypto, 0, 10_000_000),
    maxWeightPct: num(SETTING_KEYS.oracleMaxWeightPct, ORACLE_DEFAULTS.maxWeightPct, 1, 100),
    minTicket: num(SETTING_KEYS.oracleMinTicket, ORACLE_DEFAULTS.minTicket, 0, 1_000_000),
    buyThreshold: num(SETTING_KEYS.oracleBuyThreshold, ORACLE_DEFAULTS.buyThreshold, 0, 100),
    reserveSymbol: reserve === "" || reserve === "NONE" ? null : reserve,
    cryptoCore: (all[SETTING_KEYS.oracleCryptoCore] ?? "").trim() || ORACLE_DEFAULTS.cryptoCore,
    contributionDay: num(SETTING_KEYS.oracleContributionDay, ORACLE_DEFAULTS.contributionDay, 1, 28),
  };
}

export async function resolveOracleSettings(): Promise<OracleSettings> {
  const all = await getAllSettings().catch(() => ({}) as Record<string, string>);
  return oracleFromSettings(all);
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: Date.now() },
    });
  if (key === SETTING_KEYS.modelAnalysis || key === SETTING_KEYS.modelFast) modelsMemo = null;
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export type ResolvedModels = { analysis: string; fast: string };

/**
 * Los modelos se leen de la base de datos, pero no hace falta hacerlo en
 * cada llamada a la IA: una pasada del motor hace 15-20 llamadas seguidas.
 * Se cachean un minuto por instancia; guardar en Ajustes invalida al momento.
 */
const MODELS_TTL_MS = 60_000;
let modelsMemo: { at: number; value: ResolvedModels } | null = null;

export async function resolveModels(): Promise<ResolvedModels> {
  if (modelsMemo && Date.now() - modelsMemo.at < MODELS_TTL_MS) return modelsMemo.value;
  const all = await getAllSettings().catch(() => ({}) as Record<string, string>);
  const value = {
    analysis: all[SETTING_KEYS.modelAnalysis] || env.modelAnalysis,
    fast: all[SETTING_KEYS.modelFast] || env.modelFast,
  };
  modelsMemo = { at: Date.now(), value };
  return value;
}

export async function resolveBaseCurrency(): Promise<string> {
  return (await getSetting(SETTING_KEYS.baseCurrency)) || env.baseCurrency;
}

export async function resolveCostMethod(): Promise<"average" | "fifo"> {
  const v = await getSetting(SETTING_KEYS.costMethod);
  return v === "fifo" ? "fifo" : "average";
}
