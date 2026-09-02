/**
 * Cierres diarios de acciones y ETF de EE. UU. desde Stooq (CSV publico, sin
 * clave). Solo se usa para RECONSTRUIR historico: el precio del dia a dia lo
 * sigue dando Finnhub. Uso personal, una peticion por simbolo y con pausa.
 */

const BASE = "https://stooq.com/q/d/l/";
const UA = "personal-invest/1.0 (uso personal)";

export type DailyClose = { date: string; close: number };

/** "AAPL" → "aapl.us"; "BRK.B" → "brk-b.us". */
export function stooqSymbol(symbol: string): string {
  return `${symbol.toLowerCase().replace(/\./g, "-")}.us`;
}

/** CSV de Stooq (Date,Open,High,Low,Close,Volume) → cierres validos, ordenados. */
export function parseStooqCsv(csv: string): DailyClose[] {
  const out: DailyClose[] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    const cells = line.split(",");
    if (cells.length < 5) continue;
    const [date, , , , close] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const c = Number(close);
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({ date, close: c });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Cierres entre dos fechas (YYYY-MM-DD, ambas incluidas). Sin datos → []. */
export async function dailyCloses(symbol: string, from: string, to: string): Promise<DailyClose[]> {
  const params = new URLSearchParams({
    s: stooqSymbol(symbol),
    d1: from.replace(/-/g, ""),
    d2: to.replace(/-/g, ""),
    i: "d",
  });
  const res = await fetch(`${BASE}?${params}`, {
    headers: { "User-Agent": UA, accept: "text/csv, text/plain, */*" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Stooq respondio HTTP ${res.status} para ${symbol}`);
  const text = await res.text();
  if (/no data|exceeded/i.test(text.slice(0, 200))) return [];
  return parseStooqCsv(text);
}
