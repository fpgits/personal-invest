import { history, latest, type FredObservation } from "./market/fred";

/**
 * Contexto macro desde FRED: tipos, inflacion y desempleo. Da el tipo libre de
 * riesgo (el Treasury a 10 anos) para valoracion y una foto del ciclo para el
 * analisis. Se cachea una hora por instancia: los datos macro se publican como
 * mucho a diario. Si no hay clave FRED, `available` es false y la UI lo oculta.
 */

/** Serie de FRED que seguimos, con su etiqueta y transformacion. */
export const MACRO_SERIES = {
  tenY: { id: "DGS10", label: "Treasury 10A", unit: "%" },
  twoY: { id: "DGS2", label: "Treasury 2A", unit: "%" },
  fedFunds: { id: "DFF", label: "Fed funds", unit: "%" },
  inflationYoY: { id: "CPIAUCSL", label: "Inflacion (IPC)", unit: "%", units: "pc1" },
  unemployment: { id: "UNRATE", label: "Desempleo", unit: "%" },
} as const;

export type MacroKey = keyof typeof MACRO_SERIES;

export type MacroSnapshot = {
  tenY: number | null;
  twoY: number | null;
  fedFunds: number | null;
  inflationYoY: number | null;
  unemployment: number | null;
  /** Treasury 10A menos 2A, en puntos porcentuales. <0 = curva invertida. */
  spread10y2y: number | null;
  /** Fecha del dato del 10A (referencia de frescura). */
  asOf: string | null;
  updatedAt: number;
  /** false si no hay clave o FRED no devolvio nada. */
  available: boolean;
};

type MacroValues = {
  tenY: number | null;
  twoY: number | null;
  fedFunds: number | null;
  inflationYoY: number | null;
  unemployment: number | null;
  asOf: string | null;
};

/** Arma el snapshot a partir de los valores crudos. Puro: derivados y disponibilidad. */
export function deriveMacro(v: MacroValues, now: number): MacroSnapshot {
  const spread10y2y = v.tenY !== null && v.twoY !== null ? round(v.tenY - v.twoY, 2) : null;
  const available =
    v.tenY !== null ||
    v.twoY !== null ||
    v.fedFunds !== null ||
    v.inflationYoY !== null ||
    v.unemployment !== null;
  return { ...v, spread10y2y, updatedAt: now, available };
}

/** El tipo libre de riesgo para valoracion: el Treasury a 10 anos. */
export function riskFreeRate(m: MacroSnapshot): number | null {
  return m.tenY;
}

/** Contexto macro en texto para el prompt de la IA. Vacio si no hay datos. */
export function macroToText(m: MacroSnapshot): string {
  if (!m.available) return "";
  const parts: string[] = [];
  if (m.tenY !== null) parts.push(`Treasury 10A ${m.tenY}%`);
  if (m.twoY !== null) parts.push(`2A ${m.twoY}%`);
  if (m.spread10y2y !== null) {
    parts.push(`curva 10-2 ${m.spread10y2y > 0 ? "+" : ""}${m.spread10y2y} pp${m.spread10y2y < 0 ? " (invertida)" : ""}`);
  }
  if (m.fedFunds !== null) parts.push(`Fed funds ${m.fedFunds}%`);
  if (m.inflationYoY !== null) parts.push(`inflacion IPC ${m.inflationYoY}% interanual`);
  if (m.unemployment !== null) parts.push(`desempleo ${m.unemployment}%`);
  return `Contexto macro (FRED): ${parts.join(", ")}.`;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Lectura con cache

const TTL_MS = 60 * 60_000;
let memo: { at: number; value: MacroSnapshot } | null = null;

export async function getMacro(now = Date.now()): Promise<MacroSnapshot> {
  if (memo && now - memo.at < TTL_MS) return memo.value;
  const [tenY, twoY, fedFunds, inflationYoY, unemployment] = await Promise.all([
    latest(MACRO_SERIES.tenY.id),
    latest(MACRO_SERIES.twoY.id),
    latest(MACRO_SERIES.fedFunds.id),
    latest(MACRO_SERIES.inflationYoY.id, { units: MACRO_SERIES.inflationYoY.units }),
    latest(MACRO_SERIES.unemployment.id),
  ]);
  const value = deriveMacro(
    {
      tenY: val(tenY),
      twoY: val(twoY),
      fedFunds: val(fedFunds),
      inflationYoY: val(inflationYoY),
      unemployment: val(unemployment),
      asOf: tenY?.date ?? null,
    },
    now,
  );
  memo = { at: now, value };
  return value;
}

/** Historia de una serie para una mini-grafica (por si se usa mas adelante). */
export async function macroHistory(key: MacroKey, start: string): Promise<FredObservation[]> {
  const s = MACRO_SERIES[key];
  const units = "units" in s ? s.units : undefined;
  return history(s.id, start, units ? { units } : {});
}

function val(o: FredObservation | null): number | null {
  return o ? round(o.value, 2) : null;
}
