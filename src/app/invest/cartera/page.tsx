import { and, desc, eq, gte, lte, notLike, or, isNull } from "drizzle-orm";
import { classColor } from "@/lib/colors";
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
import { GroupPicker } from "@/components/group-picker";
import { PeriodPicker } from "@/components/period-picker";
import {
  accountGroup,
  accountInGroup,
  classInGroup,
  GROUP_LABELS,
  type GroupKey,
} from "@/lib/group";
import { readGroup } from "@/lib/group-server";
import {
  listCashFlows,
  returnOnContributions,
  summarizeContributions,
  type CashFlowView,
} from "@/lib/cashflows";
import { periodBounds } from "@/lib/period";
import { readPeriod } from "@/lib/period-server";
import { computePortfolio, type Position } from "@/lib/portfolio";
import { missingRequired } from "@/lib/setup";
import { SetupNotice } from "@/components/setup-notice";
import { fmtDate, fmtMoney, fmtPct, fmtQty } from "@/lib/utils";

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

/**
 * Aportes de capital: el efectivo real que has metido (y sacado) de cada
 * cuenta, con su historial. El neto aportado es lo que NO cuenta como
 * ganancia; el retorno real es el valor actual menos ese neto. Respeta el
 * grupo (Todo/Bolsa/Cripto) y muestra siempre la division Bolsa/Cripto.
 */
function CashFlowCard({
  flowsAll,
  currentValue,
  group,
  currency,
  fromMs,
  toMs,
  periodLabel,
  hasAny,
}: {
  flowsAll: CashFlowView[];
  /** Valor actual del grupo seleccionado. */
  currentValue: number;
  group: GroupKey;
  currency: string;
  fromMs: number;
  toMs: number;
  periodLabel: string;
  hasAny: boolean;
}) {
  if (!hasAny) {
    return (
      <Card className="mt-4">
        <CardTitle>Aportes de capital</CardTitle>
        <p className="text-sm text-faint">
          Todavia no hay aportes registrados. Se rellenan solos en la proxima
          sincronizacion: de IBKR salen de la seccion Cash Transactions de tu
          Flex Query (activala si no la tienes), y de Binance de su historial de
          depositos y retiros.
        </p>
      </Card>
    );
  }

  // Neto del grupo seleccionado (para el titular) y division fija Bolsa/Cripto.
  const sel = summarizeContributions(flowsAll.filter((f) => accountInGroup(group, f.accountType)));
  const bolsa = summarizeContributions(flowsAll.filter((f) => accountGroup(f.accountType) === "bolsa"));
  const cripto = summarizeContributions(flowsAll.filter((f) => accountGroup(f.accountType) === "cripto"));
  const ret = returnOnContributions(currentValue, sel.net);
  const flowsInPeriod = flowsAll.filter(
    (f) => accountInGroup(group, f.accountType) && f.occurredAt >= fromMs && f.occurredAt <= toMs,
  );

  return (
    <Card className="mt-4" padded={false}>
      <div className="p-5 pb-3">
        <CardTitle>Aportes de capital{group !== "all" && ` · ${GROUP_LABELS[group]}`}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-faint">Capital neto aportado</p>
            <p className="tnum text-lg font-semibold">{fmtMoney(sel.net, currency)}</p>
            <p className="text-xs text-faint">
              {fmtMoney(sel.deposits, currency)} en aportes
              {sel.withdrawals > 0 && ` · ${fmtMoney(sel.withdrawals, currency)} retirado`}
            </p>
          </div>
          <div>
            <p className="text-xs text-faint">Valor actual</p>
            <p className="tnum text-lg font-semibold">{fmtMoney(currentValue, currency)}</p>
          </div>
          <div>
            <p className="text-xs text-faint">Retorno sobre lo aportado</p>
            <p className={`tnum text-lg font-semibold ${ret.gain >= 0 ? "text-up" : "text-down"}`}>
              {fmtMoney(ret.gain, currency)}
              {ret.gainPct !== null && (
                <span className="ml-1 text-sm font-normal">({fmtPct(ret.gainPct)})</span>
              )}
            </p>
          </div>
        </div>

        {/* Division Bolsa / Cripto: en la vista "Todo" (al filtrar, el titular
            ya es de ese grupo, asi que no hace falta repetirlo). */}
        {group === "all" && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            <span>
              Bolsa: <b className="tnum text-text">{fmtMoney(bolsa.net, currency)}</b>
            </span>
            <span>
              Cripto:{" "}
              <b className="tnum text-text">
                {cripto.byAccount.length > 0 ? fmtMoney(cripto.net, currency) : "sin datos"}
              </b>
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-border px-5 py-2.5 text-xs text-faint">
        Movimientos · {periodLabel} ({flowsInPeriod.length})
      </div>
      {flowsInPeriod.length === 0 ? (
        <p className="px-5 pb-5 pt-1 text-sm text-faint">
          Sin aportes ni retiros con fecha en este periodo. El neto de arriba es
          histórico.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <tbody className="divide-y divide-border">
              {flowsInPeriod.map((f) => (
                <tr key={f.id} className="transition hover:bg-surface-2">
                  <td className="px-5 py-2.5 text-xs text-faint">{fmtDate(f.occurredAt)}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={f.kind === "deposit" ? "up" : "down"}>
                      {f.kind === "deposit" ? "Aporte" : "Retiro"}
                    </Badge>
                  </td>
                  <td className="tnum px-3 py-2.5 text-right font-medium">
                    {fmtMoney(f.amount, f.currency)}
                  </td>
                  <td className="px-5 py-2.5 text-right text-xs text-faint">{f.accountName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

  const [{ period }, group] = await Promise.all([readPeriod(), readGroup()]);
  const { fromMs, toMs } = periodBounds(period);
  const [portfolio, txRowsAll, cashFlowsAll] = await Promise.all([
    computePortfolio(),
    db
      .select({ tx: transactions, asset: assets, account: accounts })
      .from(transactions)
      .innerJoin(assets, eq(transactions.assetId, assets.id))
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(
        and(
          gte(transactions.executedAt, fromMs),
          lte(transactions.executedAt, toMs),
          // Los ajustes de cuadre (saldo de efectivo, Open Positions) se
          // regeneran en cada sync con la fecha del sync: no son operaciones.
          or(isNull(transactions.externalId), notLike(transactions.externalId, "%reconcile%")),
        ),
      )
      .orderBy(desc(transactions.executedAt))
      .limit(200),
    listCashFlows(),
  ]);

  // Filtro por grupo (Todo/Bolsa/Cripto), global de la seccion.
  const positions = portfolio.positions.filter((p) => classInGroup(group, p.group));
  const closed = portfolio.closed.filter((p) => classInGroup(group, p.asset.assetClass));
  const txRows = txRowsAll.filter((r) => classInGroup(group, r.asset.assetClass));
  // Totales del grupo: si es "Todo" coinciden con los de la cartera entera.
  const groupValue = positions.reduce((s, p) => s + p.value, 0);
  const groupCost = positions.reduce((s, p) => s + p.costBasis, 0);
  const groupUnrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const groupUnrealizedPct = groupCost > 0 ? (groupUnrealized / groupCost) * 100 : 0;

  return (
    <>
      <PageTitle
        subtitle={`${positions.length} posiciones abiertas · coste medio ${portfolio.currency}`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <GroupPicker />
            <PeriodPicker />
          </div>
        }
      >
        Cartera
      </PageTitle>

      {positions.length === 0 ? (
        <EmptyState title="No hay posiciones abiertas">
          {group === "all"
            ? "Conecta IBKR o Binance con claves de solo lectura en la pestana de Cuentas y sincroniza. La cartera se llena sola."
            : "Nada en este grupo. Cambia el selector de arriba a Todo para ver el resto."}
        </EmptyState>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-3">
            <span className="text-sm text-muted">Valor total</span>
            <div className="flex items-baseline gap-3">
              <span className="tnum text-base font-semibold">
                {fmtMoney(groupValue, portfolio.currency)}
              </span>
              <Delta
                value={groupUnrealized}
                pct={groupUnrealizedPct}
                currency={portfolio.currency}
              />
            </div>
          </div>
          {SECTIONS.map((s) => (
            <PositionSection
              key={s.label}
              label={s.label}
              currency={portfolio.currency}
              positions={positions.filter((p) => s.groups.includes(p.group))}
            />
          ))}
        </>
      )}

      {closed.length > 0 && (
        <Card className="mt-4">
          <CardTitle>Posiciones cerradas</CardTitle>
          <ul className="divide-y divide-border">
            {closed.map((p) => (
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

      <CashFlowCard
        flowsAll={cashFlowsAll}
        currentValue={groupValue}
        group={group}
        currency={portfolio.currency}
        fromMs={fromMs}
        toMs={toMs}
        periodLabel={period.label}
        hasAny={cashFlowsAll.length > 0}
      />

      <Card className="mt-4" padded={false}>
        <div className="p-5 pb-3">
          <CardTitle action={<span className="text-xs text-faint">{txRows.length} en el periodo</span>}>
            Operaciones · {period.label}
          </CardTitle>
        </div>
        {txRows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-faint">
            Ninguna operacion con fecha en este periodo. Cambia el periodo arriba. Los ajustes de
            sincronizacion (saldo de efectivo, cuadre con el broker) no cuentan como operaciones.
          </p>
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
