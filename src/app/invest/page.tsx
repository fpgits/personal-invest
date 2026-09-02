import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { SetupNotice } from "@/components/setup-notice";
import { Badge, EmptyState, PageTitle } from "@/components/ui";
import { PeriodPicker } from "@/components/period-picker";
import { dashboardPeriod } from "@/lib/period-metrics";
import { readPeriod } from "@/lib/period-server";
import { computePortfolio } from "@/lib/portfolio";
import { missingRequired } from "@/lib/setup";
import { fmtDateTime } from "@/lib/utils";
import { DashboardView } from "./dashboard-view";

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

  const [portfolio, { spec, period }] = await Promise.all([computePortfolio(), readPeriod()]);

  if (portfolio.positions.length === 0 && portfolio.closed.length === 0) {
    return (
      <>
        <PageTitle subtitle="Tu cartera de bolsa y cripto en un sitio">
          Resumen
        </PageTitle>
        <EmptyState
          title="Todavia no hay nada aqui"
          action={
            <Link
              href="/invest/cuentas"
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              Conectar una cuenta
            </Link>
          }
        >
          Conecta IBKR o Binance con claves de solo lectura y la cartera se
          sincroniza sola. Es solo lectura: no se opera desde aqui.
        </EmptyState>
      </>
    );
  }

  // El periodo se calcula con los snapshots; si falla, el Resumen sigue
  // funcionando sin la parte de periodo.
  const periodData = await dashboardPeriod(period, portfolio, spec.today).catch((e: unknown) => {
    console.error("[resumen] periodo:", e instanceof Error ? e.message : String(e));
    return null;
  });

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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {portfolio.degraded && (
              <Badge tone="warn">
                <RefreshCw size={11} className="mr-1" />
                Algun precio desactualizado
              </Badge>
            )}
            <PeriodPicker />
          </div>
        }
      >
        Resumen
      </PageTitle>

      <DashboardView
        positions={portfolio.positions}
        closed={portfolio.closed}
        currency={portfolio.currency}
        period={periodData}
        slices={portfolio.byClass}
      />
    </>
  );
}
