import { sql } from "drizzle-orm";
import { db } from "@/db";
import { universeCompanies, universeRuns } from "@/db/schema-universe";
import { MAX_STALE_YEARS, MIN_CONCEPTS, MIN_YEARS } from "./edgar-bulk";
import { padCik, secFetch } from "./edgar";
import type { FinancialsView } from "./edgar-facts";
import {
  financialsFromFrames,
  frameUrl,
  namesFromFrames,
  pivotFrames,
  FRAME_CONCEPTS,
  type ByCompany,
  type Frame,
} from "./edgar-frames";
import { id } from "./utils";

/**
 * El barrido: valorar el mercado entero, no solo lo que tienes.
 *
 * Baja los 18 conceptos que necesita el motor para cada uno de los ultimos
 * años —una peticion por concepto y año, no por empresa— y deja en
 * `universe_companies` la historia destilada de todo el que declare a la SEC.
 *
 * Medido contra la SEC el 14/09/2026: `NetIncomeLoss/CY2024` son 6.054
 * empresas en 901 KB. Ocho años son 144 peticiones, ~18 segundos al limite de
 * acceso justo, y cabe de sobra en un cron de 300.
 *
 * Lo que NO hace: inventar. Si un concepto no esta para un año, esa serie se
 * queda corta y la empresa acaba con menos cobertura — y si no llega al minimo
 * queda marcada como no valorable y no entra en ningun ranking. Un hueco tiene
 * que verse como un hueco.
 */

/** 8 ejercicios es lo que consume `buildFinancials`; pedir mas es gastar. */
export const DEFAULT_YEARS = 8;
/** Por debajo del limite de la SEC (10/s), con margen para no rozarlo. */
export const REQUESTS_PER_SECOND = 8;
/** Filas por INSERT. Turso traga bien lotes de este tamaño. */
const WRITE_CHUNK = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Los años a pedir, del mas reciente hacia atras. */
export function yearsToSweep(now = Date.now(), count = DEFAULT_YEARS): number[] {
  // El ejercicio en curso casi nunca esta completo en los frames, asi que se
  // arranca en el anterior: pedirlo solo gasta peticiones para nada.
  const last = new Date(now).getUTCFullYear() - 1;
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i));
}

export type SweepProgress = { fetched: number; total: number; misses: number };

export type SweepResult = {
  /** Peticiones que devolvieron datos. */
  fetched: number;
  /** Concepto+año que no existen en la SEC. Normal: no todo tag tiene todo año. */
  misses: number;
  /** Empresas vistas en algun frame. */
  seen: number;
  /** Empresas con al menos un ejercicio armado. */
  parsed: number;
  /** Empresas que pasan el minimo para entrar en un ranking. */
  usable: number;
  /** Cuantas de las valorables tienen ticker conocido. */
  withTicker: number;
  seconds: number;
  sourceDate: string;
  wrote: boolean;
};

/** CIK -> { ticker, nombre } desde el mapa publico de la SEC. */
async function tickerMap(): Promise<Map<string, { ticker: string; title: string }>> {
  const json = (await (await secFetch("https://www.sec.gov/files/company_tickers.json")).json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const out = new Map<string, { ticker: string; title: string }>();
  for (const row of Object.values(json)) {
    if (!row?.cik_str || !row.ticker) continue;
    const key = padCik(row.cik_str);
    // Una empresa puede tener varias clases (GOOG/GOOGL). Se queda la primera,
    // que es la que la SEC lista antes; el ranking no necesita las dos.
    if (!out.has(key)) out.set(key, { ticker: row.ticker.toUpperCase(), title: row.title ?? "" });
  }
  return out;
}

/**
 * Descarga los frames y los pivota SOBRE LA MARCHA.
 *
 * Importa el orden: si se guardaran las 144 respuestas crudas antes de
 * pivotar serian ~100 MB de JSON vivo mas lo que pesa ya parseado. Se pivota
 * cada una y se suelta, asi que en memoria solo queda lo destilado.
 */
async function collect(
  years: number[],
  onProgress?: (p: SweepProgress) => void,
): Promise<{ by: ByCompany; names: Map<string, string>; fetched: number; misses: number }> {
  const by: ByCompany = new Map();
  const names = new Map<string, string>();
  const total = FRAME_CONCEPTS.length * years.length;
  let fetched = 0;
  let misses = 0;

  const gap = Math.ceil(1000 / REQUESTS_PER_SECOND);
  for (const concept of FRAME_CONCEPTS) {
    for (const year of years) {
      const started = Date.now();
      try {
        const frame = (await (await secFetch(frameUrl(concept, year))).json()) as Frame;
        const one = [{ tag: concept.tag, year, frame }];
        // Se funde en el acumulador y la respuesta cruda queda para el GC.
        for (const [cik, byTag] of pivotFrames(one)) {
          let dst = by.get(cik);
          if (!dst) by.set(cik, (dst = new Map()));
          for (const [tag, pts] of byTag) {
            const prev = dst.get(tag) ?? [];
            dst.set(tag, [...prev.filter((p) => p.fy !== year), ...pts].sort((a, b) => a.fy - b.fy));
          }
        }
        for (const [cik, name] of namesFromFrames(one)) if (!names.has(cik)) names.set(cik, name);
        fetched++;
      } catch {
        // Un 404 aqui es informacion, no un fallo: significa que ese concepto
        // no existe para ese año. Se cuenta y se sigue.
        misses++;
      }
      onProgress?.({ fetched, total, misses });
      const left = gap - (Date.now() - started);
      if (left > 0) await sleep(left);
    }
  }
  return { by, names, fetched, misses };
}

/** Misma regla que el camino del zip: una sola definicion de "valorable". */
export function coverageFromView(
  view: FinancialsView,
  concepts: number,
  now: number,
): { years: number; concepts: number; lastFy: number | null; usable: boolean } {
  const years = view.years.length;
  const lastFy = view.years.at(-1)?.fy ?? null;
  const fresh = lastFy !== null && new Date(now).getUTCFullYear() - lastFy <= MAX_STALE_YEARS;
  return { years, concepts, lastFy, usable: years >= MIN_YEARS && concepts >= MIN_CONCEPTS && fresh };
}

/**
 * El barrido completo. `dryRun` cuenta sin escribir, que es como conviene
 * hacer la primera pasada: lo que interesa saber antes de nada es cuantas
 * empresas quedan valorables, no llenar una tabla.
 */
export async function sweepMarket(
  opts: { years?: number; dryRun?: boolean; now?: number; onProgress?: (p: SweepProgress) => void } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const t0 = Date.now();
  const years = yearsToSweep(now, opts.years ?? DEFAULT_YEARS);
  const sourceDate = new Date(now).toISOString().slice(0, 10);

  const [{ by, names, fetched, misses }, tickers] = await Promise.all([
    collect(years, opts.onProgress),
    tickerMap().catch(() => new Map<string, { ticker: string; title: string }>()),
  ]);

  const rows: Array<typeof universeCompanies.$inferInsert> = [];
  let parsed = 0;
  let usable = 0;
  let withTicker = 0;

  for (const [cik, byTag] of by) {
    const view = financialsFromFrames(byTag, now);
    if (view.years.length === 0) continue;
    parsed++;
    const cov = coverageFromView(view, byTag.size, now);
    if (cov.usable) {
      usable++;
      if (tickers.has(cik)) withTicker++;
    }
    const known = tickers.get(cik);
    rows.push({
      cik,
      ticker: known?.ticker ?? null,
      name: known?.title || names.get(cik) || cik,
      sic: null,
      years: JSON.stringify(view.years),
      sharesOut: view.sharesOut,
      covYears: cov.years,
      covConcepts: cov.concepts,
      covLastFy: cov.lastFy,
      usable: cov.usable,
      sourceDate,
      updatedAt: now,
    });
  }

  if (!opts.dryRun && rows.length > 0) {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      await db
        .insert(universeCompanies)
        .values(chunk)
        // `excluded` es la fila que se intentaba insertar: cada empresa se
        // actualiza con SU valor nuevo, no con uno comun a todo el lote.
        .onConflictDoUpdate({
          target: universeCompanies.cik,
          set: {
            ticker: sql`excluded.ticker`,
            name: sql`excluded.name`,
            years: sql`excluded.years`,
            sharesOut: sql`excluded.shares_out`,
            covYears: sql`excluded.cov_years`,
            covConcepts: sql`excluded.cov_concepts`,
            covLastFy: sql`excluded.cov_last_fy`,
            usable: sql`excluded.usable`,
            sourceDate: sql`excluded.source_date`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  const seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
  const result: SweepResult = {
    fetched,
    misses,
    seen: by.size,
    parsed,
    usable,
    withTicker,
    seconds,
    sourceDate,
    wrote: !opts.dryRun && rows.length > 0,
  };

  if (result.wrote) {
    await db
      .insert(universeRuns)
      .values({
        id: id(),
        sourceDate,
        seen: result.seen,
        parsed: result.parsed,
        usable: result.usable,
        seconds,
        note: `${fetched} frames, ${misses} sin datos, ${withTicker} valorables con ticker`,
        at: now,
      })
      .catch(() => undefined);
  }
  return result;
}
