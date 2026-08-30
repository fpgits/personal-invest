"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Upload, X } from "lucide-react";
import type { SearchHit } from "@/lib/market/types";
import { AssetSearch } from "./asset-search";
import { AssetIcon, Card, ClassBadge } from "./ui";
import { api } from "@/lib/utils";

const TYPES = [
  { value: "buy", label: "Compra" },
  { value: "sell", label: "Venta" },
  { value: "dividend", label: "Dividendo" },
  { value: "transfer_in", label: "Deposito" },
  { value: "transfer_out", label: "Retiro" },
  { value: "fee", label: "Comision" },
] as const;

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent";
const label = "mb-1.5 block text-xs text-muted";

export function TransactionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState<SearchHit | null>(null);
  const [type, setType] = useState<string>("buy");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [fee, setFee] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAsset(null);
    setQuantity("");
    setPrice("");
    setFee("");
    setNote("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!asset) return;
    setBusy(true);
    setError(null);

    const res = await fetch(api("/api/transactions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: asset.symbol,
        assetClass: asset.assetClass,
        type,
        quantity: Number(quantity) || 1,
        price: Number(price) || 0,
        fee: Number(fee) || 0,
        currency: "USD",
        executedAt: new Date(`${date}T12:00:00`).getTime(),
        note: note || undefined,
      }),
    });

    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo guardar");
      return;
    }
    reset();
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="flex gap-2">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          <Plus size={15} />
          Anadir operacion
        </button>
        <CsvImport />
      </div>
    );
  }

  return (
    <Card className="w-full">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">Nueva operacion</h3>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-faint transition hover:text-text"
          aria-label="Cerrar"
        >
          <X size={16} />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {asset ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2.5">
            <AssetIcon symbol={asset.symbol} logoUrl={asset.logoUrl} size={28} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{asset.symbol}</p>
              <p className="truncate text-xs text-faint">{asset.name}</p>
            </div>
            <ClassBadge assetClass={asset.assetClass} />
            <button
              type="button"
              onClick={() => setAsset(null)}
              className="text-faint transition hover:text-text"
              aria-label="Cambiar activo"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div>
            <span className={label}>Activo</span>
            <AssetSearch onPick={setAsset} autoFocus />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="tx-type">
              Tipo
            </label>
            <select
              id="tx-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={field}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="tx-date">
              Fecha
            </label>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor="tx-qty">
              Cantidad
            </label>
            <input
              id="tx-qty"
              type="number"
              step="any"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="tx-price">
              Precio por unidad
            </label>
            <input
              id="tx-price"
              type="number"
              step="any"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0"
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="tx-fee">
              Comision
            </label>
            <input
              id="tx-fee"
              type="number"
              step="any"
              min="0"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0"
              className={field}
            />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="tx-note">
            Nota
          </label>
          <input
            id="tx-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Opcional"
            className={field}
          />
        </div>

        {error && <p className="text-sm text-down">{error}</p>}

        <button
          type="submit"
          disabled={busy || !asset || !quantity}
          className="w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Guardando..." : "Guardar operacion"}
        </button>
      </form>
    </Card>
  );
}

type Preview = {
  willImport: number;
  errors: Array<{ line: number; message: string }>;
  detectedColumns: Record<string, string>;
};

export function CsvImport() {
  const router = useRouter();
  const [content, setContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setContent(text);
    setBusy(true);
    const res = await fetch(api("/api/import/csv?dryRun=1"), {
      method: "POST",
      body: text,
    });
    setPreview(await res.json());
    setBusy(false);
    e.target.value = "";
  }

  async function confirm() {
    if (!content) return;
    setBusy(true);
    const res = await fetch(api("/api/import/csv"), { method: "POST", body: content });
    const data = await res.json();
    setBusy(false);
    setPreview(null);
    setContent(null);
    setDone(`${data.imported ?? 0} operaciones importadas`);
    router.refresh();
  }

  return (
    <>
      <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong">
        <Upload size={15} />
        Importar CSV
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      </label>

      {done && <span className="self-center text-sm text-up">{done}</span>}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card className="max-h-[80vh] w-full max-w-lg overflow-auto">
            <h3 className="mb-3 font-medium">Vista previa del import</h3>

            {preview.willImport > 0 ? (
              <p className="text-sm">
                Se importaran{" "}
                <strong className="text-up">{preview.willImport}</strong>{" "}
                operaciones.
              </p>
            ) : (
              <p className="text-sm text-down">
                No se reconocio ninguna fila valida.
              </p>
            )}

            {preview.detectedColumns && (
              <div className="mt-3 rounded-lg bg-surface-2 p-3 text-xs">
                <p className="mb-1.5 text-faint">Columnas detectadas</p>
                {Object.entries(preview.detectedColumns)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <span className="text-muted">{k}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))}
              </div>
            )}

            {preview.errors?.length > 0 && (
              <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-down/25 bg-down-dim/40 p-3 text-xs">
                <p className="mb-1.5 font-medium text-down">
                  {preview.errors.length} filas con problemas
                </p>
                {preview.errors.slice(0, 12).map((er, i) => (
                  <p key={i} className="text-muted">
                    Linea {er.line}: {er.message}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={confirm}
                disabled={busy || preview.willImport === 0}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? "Importando..." : "Importar"}
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setContent(null);
                }}
                className="rounded-lg border border-border px-3 py-2 text-sm transition hover:border-border-strong"
              >
                Cancelar
              </button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
