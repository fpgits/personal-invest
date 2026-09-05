"use client";

import useSWR from "swr";
import { useState } from "react";
import { ChevronDown, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui";
import { api, cn, fmtMoney } from "@/lib/utils";
import {
  FACTOR_SHORT,
  POSTURE_LABEL,
  type FactorKey,
  type Posture,
} from "@/lib/conviction-labels";
import type { ConvictionResult, Factor } from "@/lib/conviction";
import { HistoryCard } from "./history-panel";
import { PlanCard } from "./plan-panel";

type Run = {
  results: ConvictionResult[];
  asOf: number;
  currency: string;
  macroAvailable: boolean;
  riskFree: number | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error ?? `HTTP ${res.status}`);
  }
  return res.json();
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

/** Color de una barra de factor por su valor (verde/ambar/rojo). */
function barColor(v: number): string {
  if (v >= 62) return "bg-up";
  if (v >= 45) return "bg-warn";
  return "bg-down";
}

const GROUPS: Array<{ title: string; hint: string; postures: Posture[] }> = [
  { title: "Comprar / anadir", hint: "Fundamentales fuertes y precio razonable", postures: ["strong_buy", "buy"] },
  { title: "Mantener", hint: "Solido pero sin margen claro ahora mismo", postures: ["hold"] },
  { title: "Reducir / vender", hint: "Sobrevalorado o con deterioro fundamental", postures: ["reduce", "sell", "avoid"] },
  { title: "Sin cobertura", hint: "Cripto, ETF o sin fundamentales", postures: ["no_coverage"] },
];

export function VeredictoPanel() {
  const { data, error, isLoading, mutate, isValidating } = useSWR<Run>(
    api("/api/conviction"),
    fetcher,
    { revalidateOnFocus: false },
  );
  const [historyKey, setHistoryKey] = useState(0);

  return (
    <div className="space-y-4">
      <PlanCard onSaved={() => setHistoryKey((k) => k + 1)} />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">
              Veredicto <span className="font-medium">determinista</span> por analisis fundamental:
              valoracion, crecimiento, calidad, solidez y consistencia sobre tus cifras reales
              (SEC EDGAR + Finnhub + FRED). Sin IA, sin inventar numeros.
            </p>
            <p className="mt-1 text-xs text-faint">
              Es una herramienta de apoyo a tu propio criterio, no una orden. La app es de solo
              lectura: nunca ejecuta operaciones.
            </p>
          </div>
          <button
            onClick={() => mutate()}
            disabled={isValidating}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:text-text disabled:opacity-40"
          >
            <RefreshCw size={14} className={cn(isValidating && "animate-spin")} />
            Recalcular
          </button>
        </div>
        {data && (
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
            <span>Tipo libre de riesgo (10A): {data.riskFree !== null ? `${data.riskFree}%` : "n/d"}</span>
            <span>{data.results.length} posiciones</span>
            <span>Actualizado {new Date(data.asOf).toLocaleString("es")}</span>
          </p>
        )}
      </Card>

      {error && (
        <EmptyState title="No se pudo calcular el veredicto">
          {(error as Error).message}
        </EmptyState>
      )}

      {isLoading && (
        <Card className="py-14 text-center text-sm text-muted">
          <RefreshCw size={20} className="mx-auto mb-3 animate-spin text-faint" />
          Reuniendo fundamentales y calculando...
        </Card>
      )}

      {data && data.results.length === 0 && (
        <EmptyState title="No hay posiciones que evaluar">
          Cuando tengas acciones en cartera, apareceran aqui con su veredicto.
        </EmptyState>
      )}

      {data &&
        GROUPS.map((g) => {
          const items = data.results.filter((r) => g.postures.includes(r.posture));
          if (items.length === 0) return null;
          return (
            <div key={g.title}>
              <div className="mb-2 mt-6 flex items-baseline gap-2 first:mt-0">
                <h3 className="text-sm font-semibold">{g.title}</h3>
                <span className="text-xs text-faint">· {g.hint}</span>
              </div>
              <div className="space-y-2">
                {items.map((r) => (
                  <VerdictRow key={r.symbol} r={r} currency={data.currency} />
                ))}
              </div>
            </div>
          );
        })}

      <HistoryCard refreshKey={historyKey} />
    </div>
  );
}

function VerdictRow({ r, currency }: { r: ConvictionResult; currency: string }) {
  const [open, setOpen] = useState(false);
  const noCov = r.posture === "no_coverage";

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        {/* Identidad + postura */}
        <div className="flex items-center gap-3 sm:w-52 sm:shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{r.symbol}</span>
              <Badge tone={TONE[r.posture]}>{POSTURE_LABEL[r.posture]}</Badge>
            </div>
            {!noCov && (
              <div className="mt-0.5 text-xs text-faint">
                Conviccion {r.score}/100 · confianza {Math.round(r.confidence * 100)}%
              </div>
            )}
          </div>
        </div>

        {noCov ? (
          <p className="flex-1 text-sm text-muted">{r.rationale}</p>
        ) : (
          <>
            {/* Barras de factores */}
            <div className="grid flex-1 grid-cols-5 gap-2">
              {r.factors.map((f) => (
                <FactorBar key={f.key} f={f} />
              ))}
            </div>

            {/* Valor razonable */}
            <div className="sm:w-36 sm:shrink-0 sm:text-right">
              {r.fairValue !== null ? (
                <>
                  <div className="text-sm font-medium">{fmtMoney(r.fairValue, currency)}</div>
                  {r.fairRange && (
                    <div className="text-[10px] tnum text-faint">
                      {fmtMoney(r.fairRange.bear, currency)} – {fmtMoney(r.fairRange.bull, currency)}
                    </div>
                  )}
                  {r.marginOfSafetyPct !== null && (
                    <div
                      className={cn(
                        "text-xs tnum",
                        r.marginOfSafetyPct > 0 ? "text-up" : r.marginOfSafetyPct < 0 ? "text-down" : "text-muted",
                      )}
                    >
                      margen {r.marginOfSafetyPct > 0 ? "+" : ""}
                      {r.marginOfSafetyPct}%
                    </div>
                  )}
                  <div className="text-[10px] text-faint">
                    {r.valuationMethod === "dcf" ? "DCF sobre FCF" : "PER justificado"}
                    {r.impliedGrowthPct !== null && ` · descuenta ${r.impliedGrowthPct >= 100 ? ">100" : r.impliedGrowthPct}%/a`}
                  </div>
                </>
              ) : (
                <div className="text-xs text-faint">valor razonable n/d</div>
              )}
            </div>
          </>
        )}
      </div>

      {!noCov && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-sm leading-relaxed text-muted">{r.rationale}</p>
          {r.caveats.length > 0 && (
            <div className="mt-2 space-y-1">
              {r.caveats.map((c, i) => (
                <p key={i} className="flex items-start gap-1.5 text-xs text-warn">
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                  {c}
                </p>
              ))}
            </div>
          )}
          {r.invalidation && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="mt-2 flex items-center gap-1 text-xs text-faint transition hover:text-muted"
            >
              <ChevronDown size={12} className={cn("transition", open && "rotate-180")} />
              Que la invalida
            </button>
          )}
          {open && r.invalidation && (
            <p className="mt-1 text-xs leading-relaxed text-muted">{r.invalidation}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function FactorBar({ f }: { f: Factor }) {
  const v = f.score;
  return (
    <div title={`${f.label}: ${f.detail}`}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] text-faint">{FACTOR_SHORT[f.key as FactorKey]}</span>
        <span className="text-[10px] tnum text-muted">{v === null ? "–" : v}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        {v !== null && (
          <div className={cn("h-full rounded-full", barColor(v))} style={{ width: `${v}%` }} />
        )}
      </div>
    </div>
  );
}
