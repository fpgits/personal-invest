import { getAllSettings } from "./settings";

/**
 * Ajustes de PoWERo. Viven en su propio modulo (no en settings.ts) para poder
 * anadirlos sin tocar el archivo grande; leen y escriben en la misma tabla de
 * ajustes que todo lo demas.
 */
export const POWERO_KEYS = {
  /** Capital nocional del libro de bolsa. Lo pones tu, del tamano que sea. */
  equityCapital: "powero_equity_capital",
  cryptoCapital: "powero_crypto_capital",
  /** manual = propone y decides; auto = apunta solo EN EL LIBRO NOCIONAL. */
  mode: "powero_mode",
  /**
   * Participaciones del indice compradas el dia que arranco cada libro. De
   * aqui sale la linea contra la que se compara: "y si te hubieras limitado a
   * comprar el indice con el mismo dinero el mismo dia".
   */
  benchUnitsEquity: "powero_bench_units_equity",
  benchUnitsCrypto: "powero_bench_units_crypto",
  /**
   * Cuando corrio el oraculo por ultima vez para PoWERo. No es un ajuste que
   * toques tu: es lo que impide que el reloj proponga dos veces el mismo dia
   * cuando cuelga de varios crons a la vez.
   */
  lastProposeAt: "powero_last_propose_at",
} as const;

/** Contra que se mide cada libro. */
export const BENCHMARK: Record<"equity" | "crypto", string> = { equity: "VOO", crypto: "BTC" };

export type PoweroSettings = {
  equityCapital: number;
  cryptoCapital: number;
  /**
   * Nunca coloca ordenes reales. "auto" significa que apunta la operacion en
   * el libro de mentira sin preguntarte, para que medir el motor no dependa
   * de que tu estes delante. Comprar de verdad lo haces tu, en tu broker.
   */
  mode: "manual" | "auto";
};

/**
 * Automatico por defecto. Un instrumento de medida que solo mide cuando te
 * acuerdas de pulsar un boton no mide nada: el sesgo lo pones tu al decidir
 * cuando mirar. Sigue sin colocar una sola orden real.
 */
export const POWERO_DEFAULTS: PoweroSettings = {
  equityCapital: 1000,
  cryptoCapital: 1000,
  mode: "auto",
};

/** Puro sobre el mapa de ajustes. Sin tope arbitrario: el capital es suyo. */
export function poweroFromSettings(all: Record<string, string>): PoweroSettings {
  const num = (key: string, fallback: number) => {
    const v = Number(all[key]);
    return all[key] !== undefined && Number.isFinite(v) && v > 0 && v <= 100_000_000 ? v : fallback;
  };
  return {
    equityCapital: num(POWERO_KEYS.equityCapital, POWERO_DEFAULTS.equityCapital),
    cryptoCapital: num(POWERO_KEYS.cryptoCapital, POWERO_DEFAULTS.cryptoCapital),
    mode: all[POWERO_KEYS.mode] === "manual" ? "manual" : POWERO_DEFAULTS.mode,
  };
}

export async function resolvePoweroSettings(): Promise<PoweroSettings> {
  const all = await getAllSettings().catch(() => ({}) as Record<string, string>);
  return poweroFromSettings(all);
}
