/**
 * Etiquetas y tipos de presentacion del motor de conviccion, en un modulo hoja
 * sin dependencias de servidor (EDGAR, env). Asi la UI de cliente puede
 * importar los textos sin arrastrar codigo de servidor al bundle del navegador.
 */

export type Posture =
  | "strong_buy"
  | "buy"
  | "hold"
  | "reduce"
  | "sell"
  | "avoid"
  | "no_coverage";

export const POSTURE_LABEL: Record<Posture, string> = {
  strong_buy: "Comprar (fuerte)",
  buy: "Comprar",
  hold: "Mantener",
  reduce: "Reducir",
  sell: "Vender",
  avoid: "Evitar",
  no_coverage: "Sin cobertura",
};

/** Orden de mayor a menor "ganas de comprar", para ranking y colores. */
export const POSTURE_RANK: Record<Posture, number> = {
  strong_buy: 6,
  buy: 5,
  hold: 4,
  reduce: 3,
  sell: 2,
  avoid: 1,
  no_coverage: 0,
};

export type FactorKey = "valuation" | "growth" | "quality" | "strength" | "consistency";

export const FACTOR_LABEL: Record<FactorKey, string> = {
  valuation: "Valoracion",
  growth: "Crecimiento",
  quality: "Calidad / rentabilidad",
  strength: "Solidez financiera",
  consistency: "Consistencia",
};

/** Etiqueta corta para las barras de factores en la UI. */
export const FACTOR_SHORT: Record<FactorKey, string> = {
  valuation: "Valor.",
  growth: "Crec.",
  quality: "Calidad",
  strength: "Solidez",
  consistency: "Consist.",
};
