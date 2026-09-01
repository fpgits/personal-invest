import { desc, eq } from "drizzle-orm";
import { classColor } from "@/lib/colors";
import { TransactionForm } from "@/components/transaction-form";
import {
  AssetIcon,
  Badge,
  Card,
  CardTitle,
  Delta,
  EmptyState,
  PageTitle,
} from "@/components/ui";
import { db } from "@/db";
import { accounts, assets, transactions } from "@/db/schema";
import { computePortfolio, type Position } from "@/lib/portfolio";
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

// Dos secciones. El efectivo NO es un cajon aparte: cuenta en el lado de su
// cuenta (p.group) — el USD del broker cae en Bolsa, el USDT del exchange en
// Cripto — y se marca con una etiqueta "Efectivo" en su fila.
const SECTIONS: Array<{ label: string; groups: string[] }> = [
  { label: "Bolsa", groups: ["equity", "etf"] },
  { label: "Cripto", groups: ["crypto"] },
];

function PositionSection({
  label,
  positions,
  currency,
}: {
  label: string;
  positions: Position[];
  currency: string;
}) {
  if (positions.length === 0) return null;
  const value = positions.reduce((s, p) => s + p.value, 0);

  return (
    <Card padded={false} className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: classColor(positions[0].group) }}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">{label}</h2>
          <span className="text-xs text-faint">{positions.length}</span>
        </div>
        <span className="tnum text-sm font-medium">
          {fmtMoney(value, currency)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
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
            {positions.map((p) => (
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
                        {p.asset.assetClass === "cash" && (
                          <Badge tone="neutral">Efectivo</Badge>
                        )}
                        {p.priceStale && <Badge tone="warn">precio viejo</Badge>}
                        {p.costEstimated && (
                          <Badge tone="neutral">coste estimado</Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-faint">{p.asset.name}</p>
                    </div>
                  </div>
                </td>
                <td className="tnum px-3 py-3 text-right">{fmtQty(p.quantity)}</td>
                <td className="tnum px-3 py-3 text-right text-muted">
                  {fmtMoney(p.avgCost, currency)}
                </td>
                <td className="tnum px-3 py-3 text-right">
                  {fmtMoney(p.price, currency)}
                </td>
                <td className="tnum px-3 py-3 text-right font-medium">
                  {fmtMoney(p.value, currency)}
                </td>
                <td className="tnum px-3 py-3 text-right text-muted">
                  {p.weight.toFixed(1)}%
                </td>
                <td className="px-5 py-3 text-right">
                  <Delta
                    value={p.unrealizedPnl}
                    pct={p.unrealizedPct}
                    currency={currency}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-strong bg-surface-2 text-sm font-medium">
              <td className="px-5 py-3">Subtotal</td>
              <td colSpan={3} />
              <td className="tnum px-3 py-3 text-right">
                {fmtMoney(value, currency)}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

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
        <>
          <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-3">
            <span className="text-sm text-muted">Valor total</span>
            <div className="flex items-baseline gap-3">
              <span className="tnum text-base font-semibold">
                {fmtMoney(portfolio.totalValue, portfolio.currency)}
              </span>
              <Delta
                value={portfolio.unrealizedPnl}
                pct={portfolio.unrealizedPct}
                currency={portfolio.currency}
              />
            </div>
          </div>
          {SECTIONS.map((s) => (
            <PositionSection
              key={s.label}
              label={s.label}
              currency={portfolio.currency}
              positions={portfolio.positions.filter((p) =>
                s.groups.includes(p.group),
              )}
            />
          ))}
        </>
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
