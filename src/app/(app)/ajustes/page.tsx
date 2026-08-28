"use client";

import useSWR from "swr";
import { useState } from "react";
import { Check } from "lucide-react";
import { Card, CardTitle, PageTitle } from "@/components/ui";

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
    error?: string;
  }>("/api/models", fetcher);
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

  const analysis = analysisEdit ?? data?.current?.analysis ?? "";
  const fast = fastEdit ?? data?.current?.fast ?? "";
  const currency =
    currencyEdit ?? settingsData?.settings?.base_currency ?? "USD";
  const costMethod =
    costMethodEdit ?? settingsData?.settings?.cost_method ?? "average";

  async function save() {
    setBusy(true);
    setSaved(false);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_analysis: analysis,
        model_fast: fast,
        base_currency: currency,
        cost_method: costMethod,
      }),
    });
    setBusy(false);
    setSaved(true);
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

      <button
        onClick={save}
        disabled={busy}
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {saved && <Check size={15} />}
        {busy ? "Guardando..." : saved ? "Guardado" : "Guardar ajustes"}
      </button>
    </>
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
