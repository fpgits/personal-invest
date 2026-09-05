"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Card, CardTitle } from "@/components/ui";
import { api } from "@/lib/utils";

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent";
const label = "mb-1.5 block text-xs text-muted";

type Field = { key: string; title: string; hint: string; placeholder: string; inputMode?: "decimal" | "numeric" | "text" };

const FIELDS: Field[] = [
  { key: "oracle_monthly_equity", title: "Aporte mensual a bolsa (USD)", hint: "Lo que sueles meter al broker cada mes.", placeholder: "4000", inputMode: "decimal" },
  { key: "oracle_monthly_crypto", title: "Aporte mensual a cripto (USD)", hint: "Lo que sueles meter al exchange cada mes.", placeholder: "2500", inputMode: "decimal" },
  { key: "oracle_max_weight_pct", title: "Peso maximo por posicion (%)", hint: "Ninguna accion recibe dinero por encima de este peso tras el aporte.", placeholder: "15", inputMode: "decimal" },
  { key: "oracle_min_ticket", title: "Ticket minimo por compra (USD)", hint: "Por debajo no se compra: evita migajas y comisiones.", placeholder: "500", inputMode: "decimal" },
  { key: "oracle_buy_threshold", title: "Umbral de compra (0-100)", hint: "Conviccion minima para recibir dinero nuevo. Mas alto = mas exigente.", placeholder: "64", inputMode: "decimal" },
  { key: "oracle_reserve_symbol", title: "Reserva (simbolo)", hint: "Donde aparcar lo que no convence, p. ej. SGOV. Escribe NONE para dejarlo en efectivo.", placeholder: "SGOV", inputMode: "text" },
  { key: "oracle_crypto_core", title: "Nucleo cripto", hint: "Reparto fijo, p. ej. BTC:60,ETH:40. El ciclo lo escala cada mes.", placeholder: "BTC:60,ETH:40", inputMode: "text" },
  { key: "oracle_contribution_day", title: "Dia de aporte (1-28)", hint: "El dia del mes en que sueles aportar.", placeholder: "1", inputMode: "numeric" },
];

/**
 * Parametros del oraculo. Guarda solo lo que has tocado; lo demas conserva
 * el valor guardado o el defecto. Cambia el plan al instante, sin redeploy.
 */
export function OracleCard({
  stored,
  onSaved,
}: {
  stored: Record<string, string> | undefined;
  onSaved?: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = (k: string) => edits[k] ?? stored?.[k] ?? "";
  const dirty = Object.keys(edits).length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const body = Object.fromEntries(Object.entries(edits).filter(([, v]) => v.trim() !== ""));
    const res = await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? `No se pudo guardar (HTTP ${res.status})`);
      return;
    }
    setEdits({});
    setSaved(true);
    onSaved?.();
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <Card className="mb-4">
      <CardTitle
        action={
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-40"
          >
            {saved && <Check size={13} />}
            {busy ? "Guardando..." : saved ? "Guardado" : "Guardar oraculo"}
          </button>
        }
      >
        Oraculo (plan mensual)
      </CardTitle>
      <p className="mb-4 text-xs text-faint">
        Codifica tu criterio: cuanto aportas, cuanto concentras y cuan exigente eres. El plan del mes en
        Analisis usa estos valores. En blanco = valor por defecto.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className={label} htmlFor={f.key}>
              {f.title}
            </label>
            <input
              id={f.key}
              inputMode={f.inputMode}
              value={value(f.key)}
              placeholder={f.placeholder}
              onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}
              className={field}
            />
            <p className="mt-1.5 text-xs text-faint">{f.hint}</p>
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
    </Card>
  );
}
