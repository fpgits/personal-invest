import { desc, eq } from "drizzle-orm";
import { classColor } from "@/components/charts";
import { TransactionForm } from "@/components/transaction-form";
import {
  AssetIcon,
  Badge,
  Card,
  CardTitle,
  ClassBadge,
  Delta,
  EmptyState,
  PageTitle,
} from "@/components/ui";
import { db } from "@/db";
import { accounts, assets, transactions } from "@/db/schema";
import { computePortfolio } from "@/lib/portfolio";
import { missingRequired } from "@/lib/setup";
import { SetupNotice } from "@/components/setup-notice";
import { fmtDate, fmtMoney, fmtQty } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  buy: "Compra",
  sell: "Venta",
  dividend: "Dividendo",
  fee: "Comision",
  transfer_in: "Deposito",
  transfer_out: "Retiro",
};

export default async function CarteraPage() {
  const missing = missingRequired();
  if (missing.length > 0) {
    return (
      <>
        <PageTitle>Cartera</PageTitle>
        <SetupNotice missing={missing} />
      </>
    );
  }

  const [portfolio, txRows] = await Promise.all([
    computePortfolio(),
    db
      .select({ tx: transactions, asset: assets, account: accounts })
      .from(transactions)
      .innerJoin(assets, eq(transactions.assetId, assets.id))
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .orderBy(desc(transactions.executedAt))
      .limit(60),
  ]);

  return (
    <>
      <PageTitle
        subtitle={`${portfolio.positions.length} posiciones abiertas · coste medio ${
          portfolio.currency
        }`}
        action={<TransactionForm />}
      >
        Cartera
      </PageTitle>

      {portfolio.positions.length === 0 ? (
        <EmptyState title="No hay posiciones abiertas">
          Anade una operacion, importa un CSV o conecta un exchange en la
          pestana de Cuentas.
        </EmptyState>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-faint">
                  <th className="px-5 py-3 font-medium">Activo</th>
                  <th className="px-3 py-3 text-right font-medium">Cantidad</th>
                  <th className="px-3 py-3 text-right font-medium">Coste medio</th>
                  <th className="px-3 py-3 text-right font-medium">Precio</th>
                  <th className="px-3 py-3 text-right font-medium">Valor</th>
                  <th className="px-3 py-3 text-right font-medium">Peso</th>
                  <th className="px-5 py-3 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {portfolio.positions.map((p) => (
                  <tr key={p.asset.id} className="transition hover:bg-surface-2">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <AssetIcon
                          symbol={p.asset.symbol}
                          logoUrl={p.asset.logoUrl}
                          size={28}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{p.asset.symbol}</span>
                            <ClassBadge assetClass={p.asset.assetClass} />
                            {p.priceStale && (
                              <Badge tone="warn">precio viejo</Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-faint">
                            {p.asset.name}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="tnum px-3 py-3 text-right">
                      {fmtQty(p.quantity)}
                    </td>
                    <td className="tnum px-3 py-3 text-right text-muted">
                      {fmtMoney(p.avgCost, portfolio.currency)}
                    </td>
                    <td className="tnum px-3 py-3 text-right">
                      {fmtMoney(p.price, portfolio.currency)}
                    </td>
                    <td className="tnum px-3 py-3 text-right font-medium">
                      {fmtMoney(p.value, portfolio.currency)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="tnum text-xs text-muted">
                          {p.weight.toFixed(1)}%
                        </span>
                        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${p.weight}%`,
                              background: classColor(p.asset.assetClass),
                            }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Delta
                        value={p.unrealizedPnl}
                        pct={p.unrealizedPct}
                        currency={portfolio.currency}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-strong bg-surface-2 text-sm font-medium">
                  <td className="px-5 py-3">Total</td>
                  <td colSpan={3} />
                  <td className="tnum px-3 py-3 text-right">
                    {fmtMoney(portfolio.totalValue, portfolio.currency)}
                  </td>
                  <td />
                  <td className="px-5 py-3 text-right">
                    <Delta
                      value={portfolio.unrealizedPnl}
                      pct={portfolio.unrealizedPct}
                      currency={portfolio.currency}
                    />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {portfolio.closed.length > 0 && (
        <Card className="mt-4">
          <CardTitle>Posiciones cerradas</CardTitle>
          <ul className="divide-y divide-border">
            {portfolio.closed.map((p) => (
              <li
                key={p.asset.id}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <AssetIcon
                  symbol={p.asset.symbol}
                  logoUrl={p.asset.logoUrl}
                  size={24}
                />
                <span className="flex-1 text-sm">{p.asset.symbol}</span>
                {p.dividends > 0 && (
                  <span className="text-xs text-faint">
                    {fmtMoney(p.dividends, portfolio.currency)} en dividendos
                  </span>
                )}
                <Delta value={p.realizedPnl} currency={portfolio.currency} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-4" padded={false}>
        <div className="p-5 pb-3">
          <CardTitle>Ultimas operaciones</CardTitle>
        </div>
        {txRows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-faint">Todavia no hay ninguna.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <tbody className="divide-y divide-border">
                {txRows.map(({ tx, asset, account }) => (
                  <tr key={tx.id} className="transition hover:bg-surface-2">
                    <td className="px-5 py-2.5 text-xs text-faint">
                      {fmtDate(tx.executedAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge
                        tone={
                          tx.type === "buy" || tx.type === "transfer_in"
                            ? "up"
                            : tx.type === "sell" || tx.type === "transfer_out"
                              ? "down"
                              : "neutral"
                        }
                      >
                        {TYPE_LABELS[tx.type] ?? tx.type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 font-medium">{asset.symbol}</td>
                    <td className="tnum px-3 py-2.5 text-right text-muted">
                      {fmtQty(tx.quantity)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-muted">
                      {tx.price > 0 ? fmtMoney(tx.price, tx.currency) : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-right text-xs text-faint">
                      {account.name}
                      {tx.source !== "manual" && ` · ${tx.source}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
