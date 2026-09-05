"use client";

import useSWR from "swr";
import { useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { Card, CardTitle, PageTitle } from "@/components/ui";
import type { AiUsageResponse, UsageBucket } from "@/lib/ai/policy";
import type { HistorySummary, RebuildReport } from "@/lib/history";
import { fmtDay } from "@/lib/period";
import { api, fmtDateTime } from "@/lib/utils";
import { OracleCard } from "./oracle-card";

type ModelInfo = {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent";
const label = "mb-1.5 block text-xs text-muted";

export default function AjustesPage() {
  const { data } = useSWR<{
    models: ModelInfo[];
    current: { analysis: string; fast: string };
    check?: { analysis: boolean; fast: boolean } | null;
    error?: string;
  }>(api("/api/models"), fetcher);
  const { data: settingsData, mutate } = useSWR<{
    settings: Record<string, string>;
  }>("/api/settings", fetcher);

  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * El estado guarda solo lo que tu has tocado. El valor mostrado se deriva de
   * lo que venga del servidor mientras no lo hayas cambiado, asi que no hace
   * falta sincronizar con efectos ni se pisa tu edicion cuando SWR revalida.
   */
  const [analysisEdit, setAnalysisEdit] = useState<string | null>(null);
  const [fastEdit, setFastEdit] = useState<string | null>(null);
  const [currencyEdit, setCurrencyEdit] = useState<string | null>(null);
  const [costMethodEdit, setCostMethodEdit] = useState<string | null>(null);
  const [budgetEdit, setBudgetEdit] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const analysis = analysisEdit ?? data?.current?.analysis ?? "";
  const fast = fastEdit ?? data?.current?.fast ?? "";
  const currency =
    currencyEdit ?? settingsData?.settings?.base_currency ?? "USD";
  const costMethod =
    costMethodEdit ?? settingsData?.settings?.cost_method ?? "average";

  async function save() {
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    const res = await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_analysis: analysis,
        model_fast: fast,
        base_currency: currency,
        cost_method: costMethod,
        ...(budgetEdit !== null ? { ai_daily_budget_usd: budgetEdit } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setSaveError(json.error ?? `No se pudo guardar (HTTP ${res.status})`);
      return;
    }
    setSaved(true);
    setBudgetEdit(null);
    mutate();
    setTimeout(() => setSaved(false), 2500);
  }

  const models = data?.models ?? [];

  return (
    <>
      <PageTitle subtitle="Se guardan en la base de datos, no hace falta redesplegar">
        Ajustes
      </PageTitle>

      <Card className="mb-4">
        <CardTitle>Modelos de OpenRouter</CardTitle>

        {data?.error && (
          <p className="mb-3 rounded-lg bg-down-dim/40 p-2.5 text-xs text-down">
            No se pudo leer el catalogo de OpenRouter ({data.error}). Puedes
            escribir el id del modelo a mano igualmente.
          </p>
        )}
        {data?.check && (!data.check.analysis || !data.check.fast) && (
          <p className="mb-3 rounded-lg bg-down-dim/40 p-2.5 text-xs text-down">
            {!data.check.analysis && (
              <>
                El modelo de analisis <code>{data.current.analysis}</code> no existe en el catalogo de OpenRouter.{" "}
              </>
            )}
            {!data.check.fast && (
              <>
                El modelo rapido <code>{data.current.fast}</code> no existe en el catalogo de OpenRouter.{" "}
              </>
            )}
            Con un id inexistente, el resumen de noticias y el motor de alertas fallan. Elige uno de la lista y guarda.
          </p>
        )}

        <div className="space-y-4">
          <ModelPicker
            id="analysis"
            title="Analisis"
            hint="El que razona sobre la cartera: chat, riesgo y tesis. Prioriza calidad."
            value={analysis}
            onChange={setAnalysisEdit}
            models={models}
          />
          <ModelPicker
            id="fast"
            title="Rapido"
            hint="El que resume noticias en lote. Prioriza precio: procesa decenas de titulares al dia."
            value={fast}
            onChange={setFastEdit}
            models={models}
          />
        </div>
      </Card>

      <Card className="mb-4">
        <CardTitle>Cartera</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="cur">
              Moneda base
            </label>
            <select
              id="cur"
              value={currency}
              onChange={(e) => setCurrencyEdit(e.target.value)}
              className={field}
            >
              {["USD", "EUR", "GBP"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-faint">
              Los precios vienen en USD. Cambiar esto no convierte todavia: es
              solo la etiqueta.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="cost">
              Metodo de coste
            </label>
            <select
              id="cost"
              value={costMethod}
              onChange={(e) => setCostMethodEdit(e.target.value)}
              className={field}
            >
              <option value="average">Coste medio</option>
              <option value="fifo">FIFO</option>
            </select>
            <p className="mt-1.5 text-xs text-faint">
              Cambia como se calcula el P&L realizado al vender. Se recalcula
              todo el historico al instante.
            </p>
          </div>
        </div>
      </Card>

      <OracleCard stored={settingsData?.settings} onSaved={() => mutate()} />

      <UsageCard
        budgetEdit={budgetEdit}
        onBudgetChange={setBudgetEdit}
        storedBudget={settingsData?.settings?.ai_daily_budget_usd ?? null}
      />

      <button
        onClick={save}
        disabled={busy}
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {saved && <Check size={15} />}
        {busy ? "Guardando..." : saved ? "Guardado" : "Guardar ajustes"}
      </button>
      {saveError && <p className="mt-2 text-sm text-down">{saveError}</p>}

      <HistoryCard />
    </>
  );
}

const usd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0";
const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * Uso y coste de OpenRouter, con el presupuesto diario editable. El gasto se
 * lee de `ai_calls`: cada llamada, buena o mala, deja tokens y coste.
 */
function UsageCard({
  budgetEdit,
  onBudgetChange,
  storedBudget,
}: {
  budgetEdit: string | null;
  onBudgetChange: (v: string) => void;
  storedBudget: string | null;
}) {
  const { data, error } = useSWR<AiUsageResponse>(api("/api/ai/usage"), fetcher, {
    refreshInterval: 60_000,
  });

  const budgetValue =
    budgetEdit ?? storedBudget ?? (data ? String(data.budget.limitUsd) : "");
  const b = data?.budget;

  return (
    <Card className="mb-4">
      <CardTitle>Uso de IA (OpenRouter)</CardTitle>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="budget">
            Presupuesto diario para tareas de fondo (USD)
          </label>
          <input
            id="budget"
            inputMode="decimal"
            value={budgetValue}
            onChange={(e) => onBudgetChange(e.target.value)}
            placeholder="2"
            className={`${field} font-mono`}
          />
          <p className="mt-1.5 text-xs text-faint">
            Resumen de noticias, eventos y propuestas de tesis se paran al llegar aqui y siguen al dia
            siguiente (UTC). El chat, el riesgo y las tesis que pides a mano nunca se bloquean. 0 = sin
            limite.
            {b && b.source !== "settings" && (
              <> Ahora mismo vale por {b.source === "env" ? "la variable AI_DAILY_BUDGET_USD" : "defecto"}.</>
            )}
          </p>
        </div>

        <div>
          <p className={label}>Hoy</p>
          {b ? (
            <>
              <p className={`text-2xl font-semibold tabular-nums ${b.blocked ? "text-down" : ""}`}>
                {usd(b.spentUsd)}
                {b.limitUsd > 0 && <span className="text-sm font-normal text-muted"> de {usd(b.limitUsd)}</span>}
              </p>
              <p className="mt-1 text-xs text-muted">
                {b.todayCalls} llamadas hoy.{" "}
                {b.blocked
                  ? "Presupuesto agotado: las tareas de fondo esperan a manana."
                  : b.limitUsd > 0
                    ? `Quedan ${usd(b.remainingUsd ?? 0)}.`
                    : "Sin limite."}
              </p>
            </>
          ) : (
            <p className="text-sm text-faint">{error ? "No se pudo leer el uso." : "Cargando..."}</p>
          )}
        </div>
      </div>

      {data && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Bucket title="Hoy" b={data.today} />
            <Bucket title="7 dias" b={data.week} />
            <Bucket title="30 dias" b={data.month} />
          </div>

          {data.byPurpose.length > 0 ? (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-faint">
                  <tr>
                    <th className="pb-2 font-normal">Tipo (30 dias)</th>
                    <th className="pb-2 text-right font-normal">Llamadas</th>
                    <th className="pb-2 text-right font-normal">Entrada</th>
                    <th className="pb-2 text-right font-normal">Salida</th>
                    <th className="pb-2 text-right font-normal">Razonam.</th>
                    <th className="pb-2 text-right font-normal">Coste</th>
                    <th className="pb-2 text-right font-normal">Media</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.byPurpose.map((p) => (
                    <tr key={p.purpose} className="border-t border-border">
                      <td className="py-1.5 pr-2">
                        {p.label}
                        <span className="ml-1.5 text-faint">
                          {data.policy[p.purpose as keyof typeof data.policy]?.tier === "fast" ? "rapido" : "analisis"}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        {p.calls}
                        {p.failed > 0 && <span className="text-down"> ({p.failed} fallidas)</span>}
                      </td>
                      <td className="py-1.5 text-right">
                        {tokens(p.promptTokens)}
                        {p.cachedTokens > 0 && <span className="text-faint"> ({tokens(p.cachedTokens)} cache)</span>}
                      </td>
                      <td className="py-1.5 text-right">{tokens(p.completionTokens)}</td>
                      <td className="py-1.5 text-right">{tokens(p.reasoningTokens)}</td>
                      <td className="py-1.5 text-right">{usd(p.cost)}</td>
                      <td className="py-1.5 text-right">{p.avgMs > 0 ? `${(p.avgMs / 1000).toFixed(1)}s` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 text-xs text-faint">Todavia no hay ninguna llamada registrada.</p>
          )}

          {data.month.unknownCost > 0 && (
            <p className="mt-3 text-xs text-warn">
              {data.month.unknownCost} llamadas sin coste conocido (OpenRouter no lo devolvio y el catalogo
              no tenia precio): el gasto real es algo mayor que el mostrado.
            </p>
          )}

          {data.lastErrors.length > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-bg p-3 text-xs text-muted">
              <p className="mb-1 text-faint">Ultimos fallos</p>
              {data.lastErrors.map((e, i) => (
                <p key={i} className="truncate">
                  {fmtDateTime(e.at)} · {data.policy[e.purpose as keyof typeof data.policy]?.label ?? e.purpose} ·{" "}
                  <span className="font-mono">{e.model}</span>: {e.error}
                </p>
              ))}
            </div>
          )}

          <p className="mt-4 text-xs text-faint">
            Modelos: <span className="font-mono">{data.models.fast}</span> para lo barato en volumen,{" "}
            <span className="font-mono">{data.models.analysis}</span> para lo que razona. Cada tipo de llamada
            tiene tope de salida, esfuerzo de razonamiento y timeout fijados en <code>src/lib/ai/policy.ts</code>;
            las tareas de fondo se enrutan al proveedor mas barato del modelo. El coste viene de la contabilidad
            de uso de OpenRouter en cada respuesta.
          </p>
        </>
      )}
    </Card>
  );
}

function Bucket({ title, b }: { title: string; b: UsageBucket }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="text-xs text-faint">{title}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{usd(b.cost)}</p>
      <p className="text-xs text-muted">
        {b.calls} llamadas · {tokens(b.promptTokens)} entrada · {tokens(b.completionTokens)} salida
        {b.failed > 0 && <span className="text-down"> · {b.failed} fallidas</span>}
      </p>
    </div>
  );
}

/** Historico de la cartera: fotos diarias y reconstruccion de los dias que faltan. */
function HistoryCard() {
  const { data, mutate } = useSWR<HistorySummary>(api("/api/history"), fetcher);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RebuildReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rebuild() {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch(api("/api/history"), { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setReport(json.report as RebuildReport);
      mutate(json.summary as HistorySummary, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo reconstruir");
    } finally {
      setRunning(false);
    }
  }

  const unpriced = report ? Object.entries(report.unpriced).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Card className="mt-6">
      <CardTitle
        action={
          <button
            onClick={rebuild}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-border-strong disabled:opacity-50"
          >
            <RefreshCw size={13} className={running ? "animate-spin" : ""} />
            {running ? "Reconstruyendo..." : "Reconstruir historico"}
          </button>
        }
      >
        Historico de la cartera
      </CardTitle>
      {data ? (
        <p className="text-sm text-muted">
          {data.total === 0
            ? "Todavia no hay ninguna foto."
            : `${data.total} fotos diarias (${data.live} en vivo, ${data.rebuilt} reconstruidas${data.unreliable > 0 ? `, ${data.unreliable} sin precios` : ""}), del ${data.first ? fmtDay(data.first) : "—"} al ${data.last ? fmtDay(data.last) : "—"}.`}
          {data.firstReliable && ` El historico fiable empieza el ${fmtDay(data.firstReliable)}.`}
        </p>
      ) : (
        <p className="text-sm text-faint">Cargando...</p>
      )}
      <p className="mt-2 text-xs text-faint">
        Cada noche se guarda una foto con precios en vivo. Reconstruir rellena hasta ayer los dias que faltan (o
        salieron sin precios) volviendo a jugar tus operaciones con los cierres de cada dia: Stooq para bolsa,
        CoinGecko para cripto. El efectivo de dias pasados sale del Equity Summary de IBKR si tu Flex Query lo
        incluye; si no, se asume el saldo actual. Las fotos en vivo buenas nunca se tocan.
      </p>
      {running && (
        <p className="mt-3 text-xs text-muted">Descargando cierres y el informe de IBKR. Puede tardar un par de minutos.</p>
      )}
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
      {report && (
        <div className="mt-3 rounded-lg border border-border bg-bg p-3 text-xs text-muted">
          <p>
            {report.days === 0
              ? "No habia nada que reconstruir."
              : `${report.days} dias del ${fmtDay(report.from)} al ${fmtDay(report.to)}: ${report.written} escritos, ${report.kept} en vivo conservados.`}
          </p>
          <p className="mt-1">
            Efectivo de dias pasados:{" "}
            {report.cashSource === "ibkr"
              ? "Equity Summary de IBKR."
              : report.cashSource === "current"
                ? "saldo actual, constante (activa 'Equity Summary in Base' en la Flex Query para el real)."
                : "ninguno."}
          </p>
          {unpriced.length > 0 && (
            <p className="mt-1">
              Sin cierre algun dia (se uso el ultimo precio de operacion):{" "}
              {unpriced.map(([s, n]) => `${s} (${n})`).join(", ")}.
            </p>
          )}
          {report.errors.length > 0 && (
            <p className="mt-1 text-warn">Errores: {report.errors.join(" · ")}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function ModelPicker({
  id,
  title,
  hint,
  value,
  onChange,
  models,
}: {
  id: string;
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  models: ModelInfo[];
}) {
  const current = models.find((m) => m.id === value);

  return (
    <div>
      <label className={label} htmlFor={id}>
        {title}
      </label>
      {models.length > 0 ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        >
          {!current && value && <option value={value}>{value} (actual)</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} · ${m.promptPrice.toFixed(2)}/${m.completionPrice.toFixed(2)}
              por M
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="proveedor/modelo"
          className={`${field} font-mono`}
        />
      )}
      <p className="mt-1.5 text-xs text-faint">{hint}</p>
      {current && (
        <p className="mt-1 text-xs text-muted">
          {current.contextLength.toLocaleString("es-ES")} tokens de contexto ·
          entrada ${current.promptPrice.toFixed(2)} / salida $
          {current.completionPrice.toFixed(2)} por millon
        </p>
      )}
    </div>
  );
}
