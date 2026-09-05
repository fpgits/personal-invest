"use client";

import { useState } from "react";
import { ChevronDown, Save, Sparkles, TriangleAlert } from "lucide-react";
import { Badge, Card, CardTitle } from "@/components/ui";
import { api, cn, fmtMoney } from "@/lib/utils";
import { POSTURE_LABEL, type Posture } from "@/lib/conviction-labels";
import type { Plan } from "@/lib/allocation";
import type { CryptoPlan } from "@/lib/crypto-cycle";
import type { OracleSettings } from "@/lib/settings";

type PlanResponse = {
  equity: Plan;
  crypto: CryptoPlan;
  settings: OracleSettings;
  batchId: string | null;
  asOf: number;
  currency: string;
  riskFree: number | null;
  error?: string;
};

const TONE: Record<Posture, "up" | "down" | "warn" | "neutral" | "accent"> = {
  strong_buy: "up",
  buy: "up",
  hold: "accent",
  reduce: "warn",
  sell: "down",
  avoid: "down",
  no_coverage: "neutral",
};

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent tnum";

/**
 * Plan del mes: el oraculo propiamente dicho. Reparte el efectivo de bolsa
 * entre lo que convence (y a reserva lo que no) y el de cripto por ciclo.
 * "Generar" solo calcula; "Guardar" lo registra como llamada para medirla.
 */
export function PlanCard({ onSaved }: { onSaved?: () => void }) {
  const [equityCash, setEquityCash] = useState<string | null>(null);
  const [cryptoCash, setCryptoCash] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState<"run" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const eq = equityCash ?? (plan ? String(plan.settings.monthlyEquity) : "");
  const cr = cryptoCash ?? (plan ? String(plan.settings.monthlyCrypto) : "");

  async function run(save: boolean) {
    setBusy(save ? "save" : "run");
    setError(null);
    try {
      const res = await fetch(api("/api/conviction/plan"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          equityCash: eq === "" ? null : Number(eq),
          cryptoCash: cr === "" ? null : Number(cr),
          save,
        }),
      });
      const data = (await res.json()) as PlanResponse;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPlan(data);
      if (save && onSaved) onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const currency = plan?.currency ?? "USD";

  return (
    <Card>
      <CardTitle
        action={
          plan?.batchId ? <Badge tone="up">Guardado como llamada del mes</Badge> : null
        }
      >
        Plan del mes
      </CardTitle>
      <p className="mb-4 text-sm text-muted">
        A donde va el dinero de este mes. Bolsa: proporcional a conviccion y margen de
        seguridad, con tope por posicion y reserva para lo que no convence. Cripto: nucleo
        fijo escalado por ciclo. Los importes se ajustan en Ajustes.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <div>
          <label className="mb-1.5 block text-xs text-muted" htmlFor="plan-eq">
            Efectivo bolsa ({currency})
          </label>
          <input
            id="plan-eq"
            inputMode="decimal"
            value={eq}
            placeholder="4000"
            onChange={(e) => setEquityCash(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-muted" htmlFor="plan-cr">
            Efectivo cripto ({currency})
          </label>
          <input
            id="plan-cr"
            inputMode="decimal"
            value={cr}
            placeholder="2500"
            onChange={(e) => setCryptoCash(e.target.value)}
            className={field}
          />
        </div>
        <button
          onClick={() => run(false)}
          disabled={busy !== null}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
        >
          <Sparkles size={14} />
          {busy === "run" ? "Calculando..." : "Generar plan"}
        </button>
        <button
          onClick={() => run(true)}
          disabled={busy !== null || !plan}
          title="Registra el plan con los precios de hoy para medir despues si acerto"
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm text-muted transition hover:text-text disabled:opacity-40"
        >
          <Save size={14} />
          {busy === "save" ? "Guardando..." : "Guardar llamada"}
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-down">{error}</p>}

      {plan && (
        <div className="space-y-5">
          {/* Bolsa */}
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
              Bolsa · {fmtMoney(plan.equity.cash, currency)}
            </h4>
            {plan.equity.lines.length === 0 ? (
              <p className="text-sm text-muted">Sin compras este mes.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {plan.equity.lines.map((l) => (
                  <li key={l.symbol} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="w-16 font-semibold">{l.symbol}</span>
                    <span className="tnum w-24 text-sm font-medium">{fmtMoney(l.amount, currency)}</span>
                    <Badge tone={TONE[l.posture]}>{POSTURE_LABEL[l.posture]}</Badge>
                    <span className="min-w-0 flex-1 text-xs text-muted">{l.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan.equity.reserve > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-sm">
                <span className="font-medium">
                  Reserva {fmtMoney(plan.equity.reserve, currency)}
                  {plan.equity.reserveSymbol ? ` en ${plan.equity.reserveSymbol}` : " en efectivo"}
                </span>
                {plan.equity.reserveReason && <span className="text-muted">· {plan.equity.reserveReason}</span>}
              </p>
            )}
            {plan.equity.trims.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-warn">Recortar o vender</p>
                <ul className="space-y-1">
                  {plan.equity.trims.map((t) => (
                    <li key={t.symbol} className="flex items-start gap-2 text-xs text-muted">
                      <Badge tone={TONE[t.posture]}>{POSTURE_LABEL[t.posture]}</Badge>
                      <span className="font-medium text-text">{t.symbol}</span>
                      <span className="min-w-0 flex-1">{t.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.equity.skipped.length > 0 && (
              <div className="mt-3">
                <button
                  onClick={() => setShowSkipped((v) => !v)}
                  className="flex items-center gap-1 text-xs text-faint transition hover:text-muted"
                >
                  <ChevronDown size={12} className={cn("transition", showSkipped && "rotate-180")} />
                  Sin dinero nuevo ({plan.equity.skipped.length})
                </button>
                {showSkipped && (
                  <ul className="mt-1 space-y-0.5">
                    {plan.equity.skipped.map((s) => (
                      <li key={s.symbol} className="text-xs text-muted">
                        <span className="font-medium text-text">{s.symbol}</span> · {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Cripto */}
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
              Cripto · {fmtMoney(plan.crypto.cash, currency)} · modelo de ciclo, no fundamental
            </h4>
            {plan.crypto.lines.length === 0 ? (
              <p className="text-sm text-muted">Define el nucleo cripto en Ajustes (p. ej. BTC:60,ETH:40).</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {plan.crypto.lines.map((l) => (
                  <li key={l.symbol} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="w-16 font-semibold">{l.symbol}</span>
                    <span className="tnum w-24 text-sm font-medium">{fmtMoney(l.amount, currency)}</span>
                    <Badge tone={l.multiplier > 1 ? "up" : l.multiplier < 1 ? "warn" : "neutral"}>
                      {l.multiplier}x
                    </Badge>
                    <span className="min-w-0 flex-1 text-xs text-muted">
                      {l.reason}
                      {l.stats?.distToMaPct !== null && l.stats?.distToMaPct !== undefined && (
                        <> · {l.stats.distToMaPct > 0 ? "+" : ""}{l.stats.distToMaPct}% vs media 200d</>
                      )}
                      {l.stats?.drawdownPct !== null && l.stats?.drawdownPct !== undefined && (
                        <> · {l.stats.drawdownPct}% desde maximo anual</>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {plan.crypto.reserve > 0 && (
              <p className="mt-2 text-sm">
                <span className="font-medium">Reserva {fmtMoney(plan.crypto.reserve, currency)} en stablecoin</span>
                <span className="text-muted"> · para la siguiente caida</span>
              </p>
            )}
            {plan.crypto.extra > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-warn">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                El ciclo pide {fmtMoney(plan.crypto.extra, currency)} mas que el efectivo del mes: tira de reserva solo si la tienes.
              </p>
            )}
          </section>

          <p className="text-xs text-faint">
            Tipo libre de riesgo {plan.riskFree !== null ? `${plan.riskFree}%` : "n/d"} · tope por posicion{" "}
            {plan.settings.maxWeightPct}% · ticket minimo {fmtMoney(plan.settings.minTicket, currency)} · umbral de
            compra {plan.settings.buyThreshold}. La app no opera: tu ejecutas fuera.
          </p>
        </div>
      )}
    </Card>
  );
}
