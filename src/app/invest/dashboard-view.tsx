"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowUpRight } from "lucide-react";
import { AllocationBar, PortfolioChart, WeightBars, type ChartMode } from "@/components/charts";
import { CLASS_LABELS, classColor } from "@/lib/colors";
import { AssetIcon, Card, CardTitle, Delta, Stat } from "@/components/ui";
import { useGroup } from "@/components/group-picker";
import { usePeriod } from "@/components/period-picker";
import { fmtDay, serializeSpec, type PeriodSpec } from "@/lib/period";
import type { DashboardPeriod, GroupKey, PeriodMetrics } from "@/lib/period-metrics";
import type { ClassBreakdown, Position } from "@/lib/portfolio";
import { api, cn, fmtMoney, fmtPct, fmtQty } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

function periodKey(spec: PeriodSpec): string {
  return api(`/api/portfolio/period?spec=${encodeURIComponent(serializeSpec(spec))}`);
}

type Group = { key: GroupKey; label: string; classes: string[] | null };

// "Bolsa" agrupa acciones, ETFs y el efectivo del broker. "Cripto" agrupa
// cripto y el efectivo del exchange. El efectivo cuenta en su lado (p.group),
// no como cajon aparte. "Todo" no filtra.
const GROUPS: Group[] = [
  { key: "all", label: "Todo", classes: null },
  { key: "bolsa", label: "Bolsa", classes: ["equity", "etf"] },
  { key: "cripto", label: "Cripto", classes: ["crypto"] },
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Texto de apoyo de la tarjeta de resultado: comparacion y limites del historico. */
function periodHint(
  m: PeriodMetrics | null,
  cmp: PeriodMetrics | null,
  cmpLabel: string | null,
  currency: string,
): string | undefined {
  if (!m || m.result === null) return "Sin historico suficiente: el snapshot corre cada noche";
  const parts: string[] = [];
  if (cmpLabel) {
    if (cmp && cmp.result !== null) {
      parts.push(
        `vs ${cmpLabel}: ${cmp.resultPct !== null ? fmtPct(cmp.resultPct) : ""} (${fmtMoney(cmp.result, currency)})`.replace(":  (", ": ("),
      );
    } else {
      parts.push(`Sin historico para ${cmpLabel}`);
    }
  }
  if (m.partial && m.start) parts.push(`historico desde ${fmtDay(m.start.date, false)}`);
  if (m.end && !m.end.live && m.end.date < m.to) parts.push(`hasta ${fmtDay(m.end.date, false)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function DashboardView({
  positions,
  closed,
  currency,
  initialPeriod,
  initialSpec,
  slices,
}: {
  positions: Position[];
  closed: Position[];
  currency: string;
  /** Metricas calculadas en el servidor con la cookie del momento de cargar. */
  initialPeriod: DashboardPeriod | null;
  initialSpec: PeriodSpec;
  slices: ClassBreakdown[];
}) {
  // El grupo (Todo/Bolsa/Cripto) es global y vive junto al selector de periodo
  // en la cabecera; aqui solo se lee.
  const { group: sel } = useGroup();

  // Las metricas del periodo van por SWR con una clave que ES el periodo
  // elegido: lo que se ve corresponde siempre a lo que marca el selector, y
  // mientras llega lo nuevo se ve un esqueleto, nunca cifras de otro periodo.
  // La respuesta del servidor con la que cargo la pagina sirve de semilla
  // para su propia clave (sin peticion extra).
  const { spec, period: selected, pending } = usePeriod();
  const key = periodKey(spec);
  const seedKey = periodKey(initialSpec);
  const { data: fetched, isLoading, error } = useSWR<DashboardPeriod>(key, fetcher, {
    fallback: initialPeriod ? { [seedKey]: initialPeriod } : {},
    // Con semilla no hace falta volver a pedir al montar; al cambiar la clave
    // no hay datos y se pide igual.
    revalidateIfStale: false,
    revalidateOnFocus: false,
    keepPreviousData: false,
  });
  const period = fetched ?? null;
  const loadingPeriod = isLoading || (pending && !period);
  // El grafico enseña por defecto el RESULTADO: lo que gano o perdio lo
  // invertido. El valor total sube con cada deposito y eso no es rentabilidad.
  const [chartMode, setChartMode] = useState<ChartMode>("result");

  // El grupo lo fija el selector global de la cabecera (honra la eleccion
  // aunque esa clase este vacia: se vera "nada en esta clase").
  const group = GROUPS.find((g) => g.key === sel) ?? GROUPS[0];
  const inGroup = (p: Position) =>
    !group.classes || group.classes.includes(p.group);
  const isAll = group.key === "all";

  const view = useMemo(() => {
    const fpos = positions.filter(inGroup);
    const fclosed = closed.filter(inGroup);
    const totalValue = sum(fpos.map((p) => p.value));
    const costBasis = sum(fpos.map((p) => p.costBasis));
    const unrealizedPnl = sum(fpos.map((p) => p.unrealizedPnl));
    const dayChange = sum(fpos.map((p) => p.dayChange));
    const realizedPnl = sum([...fpos, ...fclosed].map((p) => p.realizedPnl));
    const dividends = sum([...fpos, ...fclosed].map((p) => p.dividends));

    return {
      fpos,
      totalValue,
      costBasis,
      unrealizedPnl,
      unrealizedPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
      dayChange,
      dayChangePct:
        totalValue - dayChange > 0
          ? (dayChange / (totalValue - dayChange)) * 100
          : 0,
      realizedPnl,
      dividends,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, closed, group.key]);

  // Posiciones por tamano y mejores/peores, con el peso recalculado dentro
  // de la seleccion (asi suman 100% del grupo, no de la cartera entera).
  const top = view.fpos
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((p) => ({
      key: p.asset.id,
      label: p.asset.symbol,
      sublabel: p.asset.name.slice(0, 28),
      value: p.value,
      weight: view.totalValue > 0 ? (p.value / view.totalValue) * 100 : 0,
      color: classColor(p.asset.assetClass),
    }));

  // Periodo: resultado del grupo elegido y su comparacion.
  const metrics = period?.groups[group.key] ?? null;
  const cmp = period?.comparison?.[group.key] ?? null;
  // La etiqueta sale del selector (instantanea); las cifras, de los datos.
  const periodLabel = selected.label;
  const cmpLabel = selected.cmpLabel;
  const chartData = metrics?.chart ?? [];

  // Mejores y peores del periodo (variacion de precio); si no hay historico
  // para el rango, cae a la variacion desde la compra.
  const periodMovers = (metrics?.movers ?? []).filter((m) => !group.classes || group.classes.includes(m.group));
  const moversByPeriod = periodMovers.length > 0;
  const movers = moversByPeriod
    ? periodMovers
        .map((m) => {
          const pos = view.fpos.find((p) => p.asset.id === m.assetId);
          return { key: m.assetId, symbol: m.symbol, logoUrl: m.logoUrl ?? pos?.asset.logoUrl ?? null, quantity: m.quantity, price: m.price, value: m.change, pct: m.changePct };
        })
        .filter((_, i, arr) => i < 3 || i >= arr.length - 3)
    : view.fpos
        .slice()
        .sort((a, b) => b.unrealizedPct - a.unrealizedPct)
        .filter((_, i, arr) => i < 3 || i >= arr.length - 3)
        .map((p) => ({ key: p.asset.id, symbol: p.asset.symbol, logoUrl: p.asset.logoUrl, quantity: p.quantity, price: p.price, value: p.unrealizedPnl, pct: p.unrealizedPct }));

  return (
    <>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Valor total"
          value={view.totalValue}
          currency={currency}
          neutral
          hint={`Coste ${fmtMoney(view.costBasis, currency)}`}
        />
        <Stat
          label="P&L no realizado"
          value={view.unrealizedPnl}
          deltaPct={view.unrealizedPct}
          currency={currency}
        />
        {loadingPeriod ? (
          <Card className="pulse-soft">
            <p className="text-xs font-medium uppercase tracking-wide text-faint">Resultado · {periodLabel}</p>
            <p className="mt-2 text-2xl font-semibold text-faint">…</p>
            <p className="mt-1 text-xs text-faint">Calculando</p>
          </Card>
        ) : error ? (
          <Card>
            <p className="text-xs font-medium uppercase tracking-wide text-faint">Resultado · {periodLabel}</p>
            <p className="mt-2 text-sm text-down">No se pudo calcular el periodo. Recarga la pagina.</p>
          </Card>
        ) : metrics && metrics.result !== null ? (
          <Stat
            label={`Resultado · ${periodLabel}`}
            value={metrics.result}
            deltaPct={metrics.resultPct ?? undefined}
            currency={currency}
            hint={periodHint(metrics, cmp, cmpLabel, currency)}
          />
        ) : (
          <Stat
            label={`Resultado · ${periodLabel}`}
            value={view.dayChange}
            deltaPct={view.dayChangePct}
            currency={currency}
            hint={`Sin historico para el periodo: se muestra hoy. ${period?.firstSnapshotDate ? `Snapshots desde ${fmtDay(period.firstSnapshotDate, false)}.` : "El snapshot corre cada noche."}`}
          />
        )}
        <Stat
          label="P&L realizado"
          value={view.realizedPnl}
          currency={currency}
          hint={
            view.dividends > 0
              ? `+ ${fmtMoney(view.dividends, currency)} en dividendos`
              : undefined
          }
        />
      </div>

      {isAll && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className={cn("lg:col-span-2", loadingPeriod && "opacity-60")}>
            <CardTitle
              action={
                <div className="flex items-center gap-3">
                  <span className="hidden text-xs text-faint lg:inline">
                    {chartMode === "result"
                      ? "Sin depositos ni retiros: solo lo que gano o perdio lo invertido."
                      : "Continua: valor total. Discontinua: capital aportado."}
                  </span>
                  <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" aria-label="Lectura del grafico">
                    {(
                      [
                        ["result", "Resultado"],
                        ["value", "Valor"],
                      ] as Array<[ChartMode, string]>
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={chartMode === m}
                        onClick={() => setChartMode(m)}
                        className={`rounded px-2 py-0.5 text-xs transition ${
                          chartMode === m ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              }
            >
              {chartMode === "result" ? "Resultado" : "Valor"} · {periodLabel}
            </CardTitle>
            <PortfolioChart data={chartData} currency={currency} mode={chartMode} />
          </Card>

          <Card>
            <CardTitle>Reparto por clase</CardTitle>
            <AllocationBar
              slices={slices.map((c) => ({
                key: c.assetClass,
                label: CLASS_LABELS[c.assetClass] ?? c.assetClass,
                value: c.value,
                weight: c.weight,
                color: classColor(c.assetClass),
              }))}
              currency={currency}
            />
          </Card>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle
            action={
              <Link
                href="/invest/cartera"
                prefetch={false}
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Ver todo <ArrowUpRight size={12} />
              </Link>
            }
          >
            Posiciones por tamano
          </CardTitle>
          {top.length > 0 ? (
            <WeightBars items={top} currency={currency} />
          ) : (
            <p className="text-sm text-faint">Nada en esta clase.</p>
          )}
        </Card>

        <Card padded={false} className={cn(loadingPeriod && "opacity-60")}>
          <div className="p-5 pb-3">
            <CardTitle
              action={
                <span className="text-xs text-faint">
                  {moversByPeriod ? `Precio en ${periodLabel.toLowerCase()}` : "Desde la compra"}
                </span>
              }
            >
              Mejores y peores
            </CardTitle>
          </div>
          {movers.length > 0 ? (
            <div className="divide-y divide-border">
              {movers.map((p) => (
                <div
                  key={p.key}
                  className="flex items-center gap-3 px-5 py-2.5"
                >
                  <AssetIcon
                    symbol={p.symbol}
                    logoUrl={p.logoUrl}
                    size={26}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {p.symbol}
                    </p>
                    <p className="tnum truncate text-xs text-faint">
                      {fmtQty(p.quantity)} · {fmtMoney(p.price, currency)}
                    </p>
                  </div>
                  <Delta
                    value={p.value}
                    pct={p.pct}
                    currency={currency}
                    className="text-sm"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="px-5 pb-5 text-sm text-faint">Nada en esta clase.</p>
          )}
        </Card>
      </div>
    </>
  );
}
