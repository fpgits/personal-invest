/**
 * Periodo de revision, comun a toda la plataforma: un rango de fechas
 * (preset o personalizado) y, opcionalmente, un rango de comparacion.
 *
 * Es puro (sin fecha del sistema, sin DB, sin React) para poder usarlo igual
 * en el servidor, en el cliente y en los tests. Las fechas son `YYYY-MM-DD` y
 * se operan como dias UTC: asi no hay saltos por zona horaria.
 *
 * La eleccion vive en una cookie (PERIOD_COOKIE) con las fechas YA resueltas
 * por el navegador, que es quien sabe que dia es para el usuario. El servidor
 * solo las lee.
 */

export const PRESETS = [
  { id: "1d", label: "Hoy" },
  { id: "7d", label: "Ultimos 7 dias" },
  { id: "30d", label: "Ultimos 30 dias" },
  { id: "90d", label: "Ultimos 90 dias" },
  { id: "6m", label: "Ultimos 6 meses" },
  { id: "12m", label: "Ultimos 12 meses" },
  { id: "mtd", label: "Mes en curso" },
  { id: "qtd", label: "Trimestre en curso" },
  { id: "ytd", label: "Ano en curso" },
  { id: "custom", label: "Personalizado" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

export const COMPARISONS = [
  { id: "none", label: "Sin comparacion" },
  { id: "prev", label: "Periodo anterior" },
  { id: "year", label: "Ano anterior" },
  { id: "year_dow", label: "Ano anterior (mismo dia de la semana)" },
  { id: "custom", label: "Personalizado" },
] as const;
export type ComparisonId = (typeof COMPARISONS)[number]["id"];

/** Lo que se guarda: preset + fechas resueltas. */
export type PeriodSpec = {
  preset: PresetId;
  /** Obligatorias con preset "custom"; para el resto son las ultimas resueltas. */
  from?: string;
  to?: string;
  comparison: ComparisonId;
  /** Inicio del rango de comparacion cuando comparison = "custom". */
  cmpFrom?: string;
  /** El "hoy" del navegador al guardar: el servidor lo usa para saber que es "en vivo". */
  today?: string;
};

export type ResolvedPeriod = {
  preset: PresetId;
  from: string;
  to: string;
  /** Dias del rango, ambos incluidos. */
  days: number;
  label: string;
  comparison: ComparisonId;
  cmpFrom: string | null;
  cmpTo: string | null;
  cmpLabel: string | null;
};

export const PERIOD_COOKIE = "invest_period";
export const DEFAULT_SPEC: PeriodSpec = { preset: "30d", comparison: "prev" };

// ---------------------------------------------------------------------------
// Dias UTC

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && toIso(t) === s;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function ms(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, n: number): string {
  return toIso(ms(iso) + n * 86_400_000);
}

/** Dias entre dos fechas, ambas incluidas. */
export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function build(y: number, m: number, d: number): string {
  // Date.UTC normaliza meses fuera de rango y dias que no existen.
  return toIso(Date.UTC(y, m - 1, d));
}

/** Misma fecha N meses/anos atras; si el dia no existe, el ultimo del mes. */
export function shiftMonths(iso: string, months: number): string {
  const { y, m, d } = parts(iso);
  const first = Date.UTC(y, m - 1 + months, 1);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return toIso(first + (Math.min(d, lastDay) - 1) * 86_400_000);
}

export function startOfMonth(iso: string): string {
  const { y, m } = parts(iso);
  return build(y, m, 1);
}

export function startOfQuarter(iso: string): string {
  const { y, m } = parts(iso);
  return build(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
}

export function startOfYear(iso: string): string {
  return build(parts(iso).y, 1, 1);
}

/** Hoy en la zona horaria del navegador (o del proceso), como YYYY-MM-DD. */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Limites en ms (dias UTC, ambos incluidos) para filtrar tablas por fecha. */
export function periodBounds(period: { from: string; to: string }): { fromMs: number; toMs: number } {
  return {
    fromMs: Date.parse(`${period.from}T00:00:00Z`),
    toMs: Date.parse(`${period.to}T23:59:59.999Z`),
  };
}

/** Hoy en UTC, para el servidor. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Resolucion

function presetRange(preset: PresetId, today: string): { from: string; to: string } {
  switch (preset) {
    case "1d":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "6m":
      return { from: addDays(shiftMonths(today, -6), 1), to: today };
    case "12m":
      return { from: addDays(shiftMonths(today, -12), 1), to: today };
    case "mtd":
      return { from: startOfMonth(today), to: today };
    case "qtd":
      return { from: startOfQuarter(today), to: today };
    case "ytd":
      return { from: startOfYear(today), to: today };
    default:
      return { from: addDays(today, -29), to: today };
  }
}

function comparisonRange(
  comparison: ComparisonId,
  from: string,
  to: string,
  cmpFrom: string | undefined,
): { from: string; to: string } | null {
  const days = daysBetween(from, to);
  switch (comparison) {
    case "prev":
      return { from: addDays(from, -days), to: addDays(from, -1) };
    case "year":
      return { from: shiftMonths(from, -12), to: shiftMonths(to, -12) };
    case "year_dow":
      // 52 semanas exactas: cae en el mismo dia de la semana.
      return { from: addDays(from, -364), to: addDays(to, -364) };
    case "custom": {
      if (!cmpFrom || !isIsoDate(cmpFrom)) return null;
      return { from: cmpFrom, to: addDays(cmpFrom, days - 1) };
    }
    default:
      return null;
  }
}

/**
 * Resuelve un spec a fechas. Los presets se calculan desde `today`; un
 * rango personalizado se toma tal cual (recortado a hoy y ordenado).
 */
export function resolvePeriod(spec: PeriodSpec, today: string): ResolvedPeriod {
  let { from, to } = presetRange(spec.preset, today);
  if (spec.preset === "custom") {
    const a = isIsoDate(spec.from) ? spec.from : addDays(today, -29);
    const b = isIsoDate(spec.to) ? spec.to : today;
    from = a <= b ? a : b;
    to = a <= b ? b : a;
    if (to > today) to = today;
    if (from > to) from = to;
  }
  const cmp = comparisonRange(spec.comparison, from, to, spec.cmpFrom);
  return {
    preset: spec.preset,
    from,
    to,
    days: daysBetween(from, to),
    label: spec.preset === "custom" ? fmtRange(from, to) : presetLabel(spec.preset),
    comparison: spec.comparison,
    cmpFrom: cmp?.from ?? null,
    cmpTo: cmp?.to ?? null,
    cmpLabel: cmp ? fmtRange(cmp.from, cmp.to) : null,
  };
}

// ---------------------------------------------------------------------------
// Cookie

const PRESET_IDS = new Set<string>(PRESETS.map((p) => p.id));
const COMPARISON_IDS = new Set<string>(COMPARISONS.map((c) => c.id));

/** Lee el spec guardado; con cualquier cosa rara vuelve al defecto. */
export function parseSpec(raw: string | null | undefined): PeriodSpec {
  if (!raw) return DEFAULT_SPEC;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== "object") return DEFAULT_SPEC;
    const preset = PRESET_IDS.has(String(j.preset)) ? (j.preset as PresetId) : DEFAULT_SPEC.preset;
    const comparison = COMPARISON_IDS.has(String(j.comparison))
      ? (j.comparison as ComparisonId)
      : DEFAULT_SPEC.comparison;
    const spec: PeriodSpec = { preset, comparison };
    if (isIsoDate(j.from)) spec.from = j.from;
    if (isIsoDate(j.to)) spec.to = j.to;
    if (isIsoDate(j.cmpFrom)) spec.cmpFrom = j.cmpFrom;
    if (isIsoDate(j.today)) spec.today = j.today;
    if (preset === "custom" && (!spec.from || !spec.to)) return DEFAULT_SPEC;
    if (comparison === "custom" && !spec.cmpFrom) spec.comparison = "none";
    return spec;
  } catch {
    return DEFAULT_SPEC;
  }
}

export function serializeSpec(spec: PeriodSpec): string {
  return JSON.stringify({
    preset: spec.preset,
    from: spec.from,
    to: spec.to,
    comparison: spec.comparison,
    cmpFrom: spec.cmpFrom,
    today: spec.today,
  });
}

function presetLabel(preset: PresetId): string {
  return PRESETS.find((p) => p.id === preset)?.label ?? preset;
}

/**
 * El servidor usa las fechas que guardo el navegador (son las del dia del
 * usuario, aunque para el reloj del servidor "hoy" sea otro dia). Si faltan
 * (cookie vieja o escrita a mano), resuelve el preset con `today`.
 */
export function resolveStored(spec: PeriodSpec, today: string): ResolvedPeriod {
  const day = isIsoDate(spec.today) ? spec.today : today;
  if (spec.preset !== "custom" && isIsoDate(spec.from) && isIsoDate(spec.to) && spec.from <= spec.to) {
    const r = resolvePeriod({ ...spec, preset: "custom" }, spec.to > day ? spec.to : day);
    return { ...r, preset: spec.preset, label: presetLabel(spec.preset) };
  }
  return resolvePeriod(spec, day);
}

// ---------------------------------------------------------------------------
// Etiquetas

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

export function fmtDay(iso: string, withYear = true): string {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/** "4 jul–2 ago 2026", "3–20 ago 2026", "1 sept 2026", "20 dic 2025–5 ene 2026". */
export function fmtRange(from: string, to: string): string {
  if (from === to) return fmtDay(from);
  const a = parts(from);
  const b = parts(to);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${fmtDay(from, false)}–${fmtDay(to)}`;
  return `${fmtDay(from)}–${fmtDay(to)}`;
}
