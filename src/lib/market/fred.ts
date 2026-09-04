/**
 * Datos macro de FRED (Federal Reserve Bank of St. Louis). API oficial y
 * gratuita, con clave. Solo lectura de series: tipos, inflacion, desempleo...
 * para dar contexto y una tasa libre de riesgo a la valoracion. Sin clave,
 * las funciones devuelven null y el panel macro simplemente no aparece.
 */
import { env } from "@/lib/env";

const BASE = "https://api.stlouisfed.org/fred";

export type FredObservation = { date: string; value: number };

/** Respuesta cruda de /series/observations (lo que nos interesa). */
type RawObservations = {
  observations?: Array<{ date: string; value: string }>;
};

/**
 * Ultima observacion valida de una serie. `units` permite pedir
 * transformaciones a FRED (p. ej. "pc1" = cambio porcentual interanual, para
 * sacar la inflacion sin bajarnos 13 meses de CPI). Devuelve null si no hay
 * clave, si la serie no responde, o si no trae dato numerico.
 */
export async function latest(
  seriesId: string,
  opts: { units?: string } = {},
): Promise<FredObservation | null> {
  const key = env.fredKey;
  if (!key) return null;
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  // FRED marca los dias sin dato con "."; pedimos varias y cogemos la primera valida.
  url.searchParams.set("limit", "8");
  if (opts.units) url.searchParams.set("units", opts.units);

  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const json = (await res.json()) as RawObservations;
    return firstValid(json.observations);
  } catch {
    return null;
  }
}

/** Serie historica (orden ascendente) desde una fecha, para una mini-grafica. */
export async function history(
  seriesId: string,
  start: string,
  opts: { units?: string } = {},
): Promise<FredObservation[]> {
  const key = env.fredKey;
  if (!key) return [];
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", start);
  url.searchParams.set("sort_order", "asc");
  if (opts.units) url.searchParams.set("units", opts.units);

  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const json = (await res.json()) as RawObservations;
    return parseObservations(json.observations);
  } catch {
    return [];
  }
}

/** Convierte las observaciones crudas en pares fecha/valor, saltando los "." */
export function parseObservations(
  raw: Array<{ date: string; value: string }> | undefined,
): FredObservation[] {
  if (!raw) return [];
  const out: FredObservation[] = [];
  for (const o of raw) {
    const v = Number(o.value);
    if (o.value !== "." && Number.isFinite(v)) out.push({ date: o.date, value: v });
  }
  return out;
}

/** Primera observacion valida de una lista en orden descendente. */
export function firstValid(
  raw: Array<{ date: string; value: string }> | undefined,
): FredObservation | null {
  return parseObservations(raw)[0] ?? null;
}
