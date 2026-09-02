"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn, fmtMoney } from "@/lib/utils";

// Colores por clase de activo: ver src/lib/colors.ts (modulo compartido
// con las paginas de servidor).

const AXIS = "#8b94a3";
const GRID = "#232830";

type Point = {
  date: string;
  value: number;
  /** Resultado acumulado desde el inicio del periodo. */
  result: number | null;
  /** Capital propio (valor − P&L total): sube con un deposito, no con una subida. */
  capital: number | null;
};

export type ChartMode = "result" | "value";

const UP = "#26c281";
const DOWN = "#f4595b";
const ACCENT = "#3987e5";

const tooltipStyle = {
  background: "#181c23",
  border: "1px solid #2f3641",
  borderRadius: 10,
  fontSize: 12,
} as const;

/**
 * Evolucion de la cartera en dos lecturas:
 * - result: lo que gano o perdio lo invertido desde el inicio del periodo.
 *   Un deposito no lo mueve. Es la lectura por defecto.
 * - value: el valor total con el capital aportado en discontinua; la
 *   distancia entre ambas es el resultado acumulado.
 */
export function PortfolioChart({
  data,
  currency = "USD",
  mode = "result",
}: {
  data: Point[];
  currency?: string;
  mode?: ChartMode;
}) {
  const usable = mode === "result" ? data.filter((p) => p.result !== null) : data;
  if (usable.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-faint">
        Hace falta al menos un par de cierres fiables en el periodo. El snapshot corre cada noche.
      </div>
    );
  }

  const last = usable[usable.length - 1];
  const resultColor = (last.result ?? 0) >= 0 ? UP : DOWN;
  const lineColor = mode === "result" ? resultColor : ACCENT;
  const gradientId = mode === "result" ? "resultFill" : "valueFill";

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={usable} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: AXIS, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={32}
            tickFormatter={(d: string) => d.slice(5)}
          />
          <YAxis
            tick={{ fill: AXIS, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={76}
            tickFormatter={(v: number) => fmtMoney(v, currency, true)}
          />
          <Tooltip
            cursor={{ stroke: AXIS, strokeDasharray: "3 3" }}
            contentStyle={tooltipStyle}
            labelStyle={{ color: AXIS, marginBottom: 4 }}
            formatter={(value, name) => [
              fmtMoney(Number(value ?? 0), currency),
              name === "value" ? "Valor" : name === "capital" ? "Capital aportado" : "Resultado",
            ]}
          />
          {mode === "result" ? (
            <>
              <ReferenceLine y={0} stroke="#5c6473" strokeDasharray="4 4" />
              <Area
                type="monotone"
                dataKey="result"
                stroke={resultColor}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#12151a" }}
              />
            </>
          ) : (
            <>
              {/* Capital primero: queda por debajo y el area de valor lo cubre. */}
              <Area
                type="monotone"
                dataKey="capital"
                stroke="#5c6473"
                strokeWidth={1}
                strokeDasharray="4 4"
                fill="none"
                dot={false}
                connectNulls
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={ACCENT}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#12151a" }}
              />
            </>
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export type AllocationSlice = {
  key: string;
  label: string;
  value: number;
  weight: number;
  color: string;
};

/**
 * Composicion como barra apilada horizontal en vez de tarta: los tamanos se
 * comparan sobre un eje comun y no hay angulos que estimar. Separador de 2px
 * del color de la superficie entre segmentos.
 */
export function AllocationBar({
  slices,
  currency = "USD",
}: {
  slices: AllocationSlice[];
  currency?: string;
}) {
  if (slices.length === 0) {
    return <p className="text-sm text-faint">Sin posiciones.</p>;
  }

  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
        {slices.map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${Math.max(s.weight, 1)}%`, background: s.color }}
            title={`${s.label}: ${s.weight.toFixed(1)}%`}
          />
        ))}
      </div>

      <ul className="mt-4 space-y-2">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2.5 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: s.color }}
              aria-hidden
            />
            <span className="flex-1 truncate">{s.label}</span>
            <span className="tnum text-muted">{s.weight.toFixed(1)}%</span>
            <span className="tnum w-24 text-right">
              {fmtMoney(s.value, currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Barras horizontales para comparar el tamano de cada posicion. */
export function WeightBars({
  items,
  currency = "USD",
  className,
}: {
  items: Array<{
    key: string;
    label: string;
    sublabel?: string;
    value: number;
    weight: number;
    color: string;
  }>;
  currency?: string;
  className?: string;
}) {
  const max = Math.max(...items.map((i) => i.weight), 1);
  return (
    <ul className={cn("space-y-3", className)}>
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">
              {i.label}
              {i.sublabel && (
                <span className="ml-2 text-xs font-normal text-faint">
                  {i.sublabel}
                </span>
              )}
            </span>
            <span className="tnum shrink-0 text-muted">
              {fmtMoney(i.value, currency)}
              <span className="ml-2 text-xs text-faint">
                {i.weight.toFixed(1)}%
              </span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(i.weight / max) * 100}%`,
                background: i.color,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
