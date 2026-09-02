"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  addDays,
  COMPARISONS,
  daysBetween,
  fmtDay,
  fmtRange,
  PERIOD_COOKIE,
  PRESETS,
  resolvePeriod,
  resolveStored,
  serializeSpec,
  todayLocal,
  type ComparisonId,
  type PeriodSpec,
  type PresetId,
  type ResolvedPeriod,
} from "@/lib/period";
import { cn } from "@/lib/utils";

/**
 * Periodo de revision, global a toda la seccion. El estado vive en un
 * contexto (para las paginas de cliente) y en una cookie (para las de
 * servidor); cada cambio reescribe la cookie y refresca el arbol de servidor.
 */

type Ctx = {
  spec: PeriodSpec;
  period: ResolvedPeriod;
  today: string;
  setSpec: (next: PeriodSpec) => void;
};

const PeriodContext = createContext<Ctx | null>(null);

function writeCookie(spec: PeriodSpec) {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PERIOD_COOKIE}=${encodeURIComponent(serializeSpec(spec))}; path=/; max-age=${365 * 86400}; SameSite=Lax${secure}`;
}

/** Fija en el spec las fechas resueltas para el dia dado. */
function withDates(spec: PeriodSpec, today: string): PeriodSpec {
  const r = resolvePeriod(spec, today);
  return { ...spec, from: r.from, to: r.to, today };
}

export function PeriodProvider({
  initial,
  serverToday,
  children,
}: {
  initial: PeriodSpec;
  serverToday: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [spec, setSpecState] = useState<PeriodSpec>(initial);
  const [today, setToday] = useState(initial.today ?? serverToday);
  const period = useMemo(() => resolveStored(spec, today), [spec, today]);

  // Tras montar manda el dia del navegador. Si la cookie es de otro dia (o de
  // otra zona horaria), se re-resuelven los presets y se refresca el servidor.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const t = todayLocal();
      const stale = spec.preset !== "custom" ? spec.to !== t : false;
      if (t === today && spec.today === t && !stale) return;
      const next = withDates(spec, t);
      setToday(t);
      setSpecState(next);
      writeCookie(next);
      if (stale || spec.today !== t) router.refresh();
    }, 0);
    return () => window.clearTimeout(id);
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSpec = useCallback(
    (next: PeriodSpec) => {
      const t = todayLocal();
      const full = withDates(next, t);
      setToday(t);
      setSpecState(full);
      writeCookie(full);
      router.refresh();
    },
    [router],
  );

  const value = useMemo(() => ({ spec, period, today, setSpec }), [spec, period, today, setSpec]);
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): Ctx {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error("usePeriod fuera de PeriodProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Selector

export function PeriodPicker({ className }: { className?: string }) {
  const { spec, period, today, setSpec } = usePeriod();
  const [open, setOpen] = useState<null | "range" | "cmp">(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pill =
    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition hover:bg-surface-2 whitespace-nowrap";

  return (
    <div ref={ref} className={cn("relative inline-flex rounded-lg border border-border bg-surface p-1", className)}>
      <button type="button" onClick={() => setOpen(open === "range" ? null : "range")} className={pill} aria-expanded={open === "range"}>
        <Calendar size={14} className="text-muted" />
        <span>{period.label}</span>
        {period.preset !== "custom" && (
          <span className="hidden text-xs text-faint sm:inline">{fmtRange(period.from, period.to)}</span>
        )}
        <ChevronDown size={12} className="text-faint" />
      </button>
      <button type="button" onClick={() => setOpen(open === "cmp" ? null : "cmp")} className={pill} aria-expanded={open === "cmp"}>
        <ArrowLeftRight size={14} className="text-muted" />
        <span className={period.cmpLabel ? "" : "text-muted"}>{period.cmpLabel ?? "Sin comparacion"}</span>
        <ChevronDown size={12} className="text-faint" />
      </button>

      {open === "range" && (
        <RangePanel
          spec={spec}
          period={period}
          today={today}
          onPreset={(id) => {
            setSpec({ ...spec, preset: id });
            setOpen(null);
          }}
          onCustom={(from, to) => {
            setSpec({ ...spec, preset: "custom", from, to });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "cmp" && (
        <ComparisonPanel
          spec={spec}
          period={period}
          today={today}
          onPick={(id) => {
            setSpec({ ...spec, comparison: id });
            setOpen(null);
          }}
          onCustom={(cmpFrom) => {
            setSpec({ ...spec, comparison: "custom", cmpFrom });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

const panelClass =
  "absolute right-0 top-full z-50 mt-1.5 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface shadow-2xl shadow-black/40";

function RangePanel({
  spec,
  period,
  today,
  onPreset,
  onCustom,
  onClose,
}: {
  spec: PeriodSpec;
  period: ResolvedPeriod;
  today: string;
  onPreset: (id: PresetId) => void;
  onCustom: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<string | null>(period.from);
  const [to, setTo] = useState<string | null>(period.to);
  // Mes izquierdo: el anterior al del fin del rango, para que el rango se vea.
  const [cursor, setCursor] = useState(() => shiftMonth(monthOf(period.to), -1));

  function pick(day: string) {
    if (day > today) return;
    if (!from || (from && to)) {
      setFrom(day);
      setTo(null);
    } else if (day < from) {
      setFrom(day);
    } else {
      setTo(day);
    }
  }

  const canApply = Boolean(from && to);

  return (
    <div className={cn(panelClass, "flex flex-col sm:flex-row")}>
      <ul className="w-full shrink-0 border-b border-border py-2 sm:w-44 sm:border-b-0 sm:border-r">
        {PRESETS.filter((p) => p.id !== "custom").map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPreset(p.id)}
              className={cn(
                "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition hover:bg-surface-2",
                spec.preset === p.id ? "text-text" : "text-muted",
              )}
            >
              {p.label}
              {spec.preset === p.id && <Check size={13} className="text-accent" />}
            </button>
          </li>
        ))}
        <li className="mt-1 border-t border-border pt-1">
          <span className={cn("block px-3 py-1.5 text-sm", spec.preset === "custom" ? "text-text" : "text-muted")}>
            Personalizado
          </span>
        </li>
      </ul>

      <div className="p-3">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="rounded-md border border-border px-2 py-1">{from ? fmtDay(from) : "Inicio"}</span>
          <span className="text-faint">→</span>
          <span className="rounded-md border border-border px-2 py-1">{to ? fmtDay(to) : "Fin"}</span>
        </div>
        <div className="flex items-start gap-4">
          <button type="button" onClick={() => setCursor(shiftMonth(cursor, -1))} aria-label="Mes anterior" className="mt-1 rounded-md p-1 text-muted hover:bg-surface-2">
            <ChevronLeft size={16} />
          </button>
          <Month month={cursor} from={from} to={to} today={today} onPick={pick} />
          <div className="hidden sm:block">
            <Month month={shiftMonth(cursor, 1)} from={from} to={to} today={today} onPick={pick} />
          </div>
          <button type="button" onClick={() => setCursor(shiftMonth(cursor, 1))} aria-label="Mes siguiente" className="mt-1 rounded-md p-1 text-muted hover:bg-surface-2">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-faint">
            {from && to ? `${daysBetween(from, to)} dias` : "Elige inicio y fin"}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text">
              Cancelar
            </button>
            <button
              type="button"
              disabled={!canApply}
              onClick={() => from && to && onCustom(from, to)}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
            >
              Aplicar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparisonPanel({
  spec,
  period,
  today,
  onPick,
  onCustom,
  onClose,
}: {
  spec: PeriodSpec;
  period: ResolvedPeriod;
  today: string;
  onPick: (id: ComparisonId) => void;
  onCustom: (cmpFrom: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState(spec.comparison === "custom");
  const [cmpFrom, setCmpFrom] = useState<string | null>(spec.cmpFrom ?? null);
  const [cursor, setCursor] = useState(() => monthOf(spec.cmpFrom ?? period.from));
  const cmpTo = cmpFrom ? addDays(cmpFrom, period.days - 1) : null;
  const previews = useMemo(() => {
    const out: Partial<Record<ComparisonId, string>> = {};
    for (const c of COMPARISONS) {
      if (c.id === "none" || c.id === "custom") continue;
      const r = resolvePeriod({ ...spec, preset: "custom", from: period.from, to: period.to, comparison: c.id }, today);
      out[c.id] = r.cmpLabel ?? "";
    }
    return out;
  }, [spec, period, today]);

  return (
    <div className={cn(panelClass, "flex flex-col sm:flex-row")}>
      <ul className="w-full py-2 sm:w-72">
        {COMPARISONS.map((c) => {
          const active = spec.comparison === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => (c.id === "custom" ? setCustom(true) : onPick(c.id))}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition hover:bg-surface-2",
                  active ? "text-text" : "text-muted",
                )}
              >
                <span>
                  {c.label}
                  {previews[c.id] && <span className="ml-2 text-xs text-faint">{previews[c.id]}</span>}
                </span>
                {active && <Check size={13} className="text-accent" />}
              </button>
            </li>
          );
        })}
      </ul>
      {custom && (
        <div className="border-t border-border p-3 sm:border-l sm:border-t-0">
          <p className="mb-2 text-xs text-muted">
            Inicio de la comparacion. Dura lo mismo que el periodo ({period.days} dias).
          </p>
          <div className="flex items-start gap-2">
            <button type="button" onClick={() => setCursor(shiftMonth(cursor, -1))} aria-label="Mes anterior" className="mt-1 rounded-md p-1 text-muted hover:bg-surface-2">
              <ChevronLeft size={16} />
            </button>
            <Month month={cursor} from={cmpFrom} to={cmpTo} today={today} onPick={(d) => setCmpFrom(d)} />
            <button type="button" onClick={() => setCursor(shiftMonth(cursor, 1))} aria-label="Mes siguiente" className="mt-1 rounded-md p-1 text-muted hover:bg-surface-2">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs text-faint">{cmpFrom && cmpTo ? fmtRange(cmpFrom, cmpTo) : "Elige el inicio"}</span>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text">
                Cancelar
              </button>
              <button
                type="button"
                disabled={!cmpFrom}
                onClick={() => cmpFrom && onCustom(cmpFrom)}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                Aplicar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendario

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DOW = ["lu", "ma", "mi", "ju", "vi", "sa", "do"];

/** "YYYY-MM" */
function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function Month({
  month,
  from,
  to,
  today,
  onPick,
}: {
  month: string;
  from: string | null;
  to: string | null;
  today: string;
  onPick: (day: string) => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Lunes = 0.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Array<string | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="w-[15.5rem] select-none">
      <p className="mb-2 text-center text-sm font-medium">
        {MONTH_NAMES[m - 1]} {y}
      </p>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
        {DOW.map((d) => (
          <span key={d} className="py-1 text-faint">
            {d}
          </span>
        ))}
        {cells.map((day, i) => {
          if (!day) return <span key={`e${i}`} />;
          const disabled = day > today;
          const isFrom = day === from;
          const isTo = day === to;
          const inRange = from && to && day > from && day < to;
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              onClick={() => onPick(day)}
              className={cn(
                "tnum h-8 text-sm transition",
                disabled ? "text-faint/50" : "hover:bg-surface-2",
                inRange && "bg-surface-2",
                (isFrom || isTo) && "bg-accent text-white hover:bg-accent",
                isFrom && "rounded-l-md",
                isTo && "rounded-r-md",
                isFrom && isTo && "rounded-md",
                !inRange && !isFrom && !isTo && "rounded-md",
                day === today && !isFrom && !isTo && "font-semibold text-accent",
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
