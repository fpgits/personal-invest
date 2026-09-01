"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AllocationBar, PortfolioChart, WeightBars } from "@/components/charts";
import { CLASS_LABELS, classColor } from "@/lib/colors";
import { AssetIcon, Card, CardTitle, Delta, Stat } from "@/components/ui";
import type { ClassBreakdown, Position } from "@/lib/portfolio";
import { fmtMoney, fmtQty } from "@/lib/utils";

type ChartPoint = { date: string; value: number; cost: number };

type Group = { key: string; label: string; classes: string[] | null };

// "Bolsa" agrupa acciones y ETFs. "Todo" no filtra.
const GROUPS: Group[] = [
  { key: "all", label: "Todo", classes: null },
  { key: "bolsa", label: "Bolsa", classes: ["equity", "etf"] },
  { key: "cripto", label: "Cripto", classes: ["crypto"] },
  { key: "efectivo", label: "Efectivo", classes: ["cash"] },
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function DashboardView({
  positions,
  closed,
  currency,
  chartData,
  slices,
}: {
  positions: Position[];
  closed: Position[];
  currency: string;
  chartData: ChartPoint[];
  slices: ClassBreakdown[];
}) {
  const [sel, setSel] = useState("all");

  // Solo mostramos las pestanas de clases que existen en la cartera.
  const tabs = useMemo(
    () =>
      GROUPS.filter(
        (g) =>
          g.classes === null ||
          positions.some((p) => g.classes!.includes(p.asset.assetClass)),
      ),
    [positions],
  );

  const group = tabs.find((g) => g.key === sel) ?? tabs[0];
  const inGroup = (p: Position) =>
    !group.classes || group.classes.includes(p.asset.assetClass);
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

  const movers = view.fpos
    .slice()
    .sort((a, b) => b.unrealizedPct - a.unrealizedPct)
    .filter((_, i, arr) => i < 3 || i >= arr.length - 3);

  return (
    <>
      <div
        className="mt-4 inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1"
        role="tablist"
        aria-label="Filtrar por clase"
      >
        {tabs.map((g) => {
          const active = g.key === group.key;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSel(g.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-accent text-white"
                  : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              {g.key === "all" ? "Todo" : CLASS_LABELS[g.classes![0]] ?? g.label}
            </button>
          );
        })}
      </div>

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
        <Stat
          label="Hoy"
          value={view.dayChange}
          deltaPct={view.dayChangePct}
          currency={currency}
        />
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
          <Card className="lg:col-span-2">
            <CardTitle
              action={
                <span className="text-xs text-faint">
                  Linea continua: valor. Discontinua: coste.
                </span>
              }
            >
              Evolucion de la cartera
            </CardTitle>
            <PortfolioChart data={chartData} currency={currency} />
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

        <Card padded={false}>
          <div className="p-5 pb-3">
            <CardTitle>Mejores y peores</CardTitle>
          </div>
          {movers.length > 0 ? (
            <div className="divide-y divide-border">
              {movers.map((p) => (
                <div
                  key={p.asset.id}
                  className="flex items-center gap-3 px-5 py-2.5"
                >
                  <AssetIcon
                    symbol={p.asset.symbol}
                    logoUrl={p.asset.logoUrl}
                    size={26}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {p.asset.symbol}
                    </p>
                    <p className="tnum truncate text-xs text-faint">
                      {fmtQty(p.quantity)} · {fmtMoney(p.price, currency)}
                    </p>
                  </div>
                  <Delta
                    value={p.unrealizedPnl}
                    pct={p.unrealizedPct}
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
