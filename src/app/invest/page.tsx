import Link from "next/link";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import {
  AllocationBar,
  PortfolioChart,
  WeightBars,
} from "@/components/charts";
import { CLASS_LABELS, classColor } from "@/lib/colors";
import { SetupNotice } from "@/components/setup-notice";
import {
  AssetIcon,
  Badge,
  Card,
  CardTitle,
  Delta,
  EmptyState,
  PageTitle,
  Stat,
} from "@/components/ui";
import { computePortfolio } from "@/lib/portfolio";
import { history } from "@/lib/snapshot";
import { missingRequired } from "@/lib/setup";
import { fmtDateTime, fmtMoney, fmtQty } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const missing = missingRequired();
  if (missing.length > 0) {
    return (
      <>
        <PageTitle>Resumen</PageTitle>
        <SetupNotice missing={missing} />
      </>
    );
  }

  const [portfolio, snaps] = await Promise.all([
    computePortfolio(),
    history(180).catch(() => []),
  ]);

  if (portfolio.positions.length === 0 && portfolio.closed.length === 0) {
    return (
      <>
        <PageTitle subtitle="Tu cartera de bolsa y cripto en un sitio">
          Resumen
        </PageTitle>
        <EmptyState
          title="Todavia no hay nada aqui"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link
                href="/invest/cuentas"
                className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
              >
                Conectar un exchange
              </Link>
              <Link
                href="/invest/cartera"
                className="rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong"
              >
                Anadir operacion a mano
              </Link>
            </div>
          }
        >
          Conecta un exchange con claves de solo lectura para que se sincronice
          solo, importa un CSV de tu broker, o mete las operaciones a mano.
        </EmptyState>
      </>
    );
  }

  const chartData = snaps.map((s) => ({
    date: s.date,
    value: s.totalValue,
    cost: s.costBasis,
  }));

  const slices = portfolio.byClass.map((c) => ({
    key: c.assetClass,
    label: CLASS_LABELS[c.assetClass] ?? c.assetClass,
    value: c.value,
    weight: c.weight,
    color: classColor(c.assetClass),
  }));

  const top = portfolio.positions.slice(0, 8).map((p) => ({
    key: p.asset.id,
    label: p.asset.symbol,
    sublabel: p.asset.name.slice(0, 28),
    value: p.value,
    weight: p.weight,
    color: classColor(p.asset.assetClass),
  }));

  const lastUpdate = Math.max(
    0,
    ...portfolio.positions.map((p) => p.priceUpdatedAt ?? 0),
  );

  return (
    <>
      <PageTitle
        subtitle={
          lastUpdate > 0 ? `Precios de ${fmtDateTime(lastUpdate)}` : undefined
        }
        action={
          portfolio.degraded ? (
            <Badge tone="warn">
              <RefreshCw size={11} className="mr-1" />
              Algun precio desactualizado
            </Badge>
          ) : null
        }
      >
        Resumen
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Valor total"
          value={portfolio.totalValue}
          currency={portfolio.currency}
          neutral
          hint={`Coste ${fmtMoney(portfolio.costBasis, portfolio.currency)}`}
        />
        <Stat
          label="P&L no realizado"
          value={portfolio.unrealizedPnl}
          deltaPct={portfolio.unrealizedPct}
          currency={portfolio.currency}
        />
        <Stat
          label="Hoy"
          value={portfolio.dayChange}
          deltaPct={portfolio.dayChangePct}
          currency={portfolio.currency}
        />
        <Stat
          label="P&L realizado"
          value={portfolio.realizedPnl}
          currency={portfolio.currency}
          hint={
            portfolio.dividends > 0
              ? `+ ${fmtMoney(portfolio.dividends, portfolio.currency)} en dividendos`
              : undefined
          }
        />
      </div>

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
          <PortfolioChart data={chartData} currency={portfolio.currency} />
        </Card>

        <Card>
          <CardTitle>Reparto por clase</CardTitle>
          <AllocationBar slices={slices} currency={portfolio.currency} />
        </Card>
      </div>

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
          <WeightBars items={top} currency={portfolio.currency} />
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-3">
            <CardTitle>Mejores y peores</CardTitle>
          </div>
          <div className="divide-y divide-border">
            {[...portfolio.positions]
              .sort((a, b) => b.unrealizedPct - a.unrealizedPct)
              .filter((_, i, arr) => i < 3 || i >= arr.length - 3)
              .map((p) => (
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
                      {fmtQty(p.quantity)} · {fmtMoney(p.price, portfolio.currency)}
                    </p>
                  </div>
                  <Delta
                    value={p.unrealizedPnl}
                    pct={p.unrealizedPct}
                    currency={portfolio.currency}
                    className="text-sm"
                  />
                </div>
              ))}
          </div>
        </Card>
      </div>
    </>
  );
}
