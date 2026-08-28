"use client";

import useSWR from "swr";
import { useState } from "react";
import {
  CheckCircle2,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge, Card, CardTitle, EmptyState, PageTitle } from "@/components/ui";
import { fmtDateTime } from "@/lib/utils";

type AccountRow = {
  id: string;
  name: string;
  type: string;
  exchangeId: string | null;
  status: string;
  lastSyncAt: number | null;
  lastError: string | null;
  apiKeyMasked: string | null;
  hasCredentials: boolean;
};

type Exchange = { id: string; name: string; needsPassphrase: boolean };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent";
const label = "mb-1.5 block text-xs text-muted";

export default function CuentasPage() {
  const { data, mutate, isLoading } = useSWR<{
    accounts: AccountRow[];
    supportedExchanges: Exchange[];
  }>("/api/accounts", fetcher);

  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const exchanges = data?.supportedExchanges ?? [];
  const accounts = data?.accounts ?? [];

  async function sync(id: string) {
    setWorking(id);
    setMessage(null);
    const res = await fetch(`/api/accounts/${id}/sync`, { method: "POST" });
    const json = await res.json();
    setWorking(null);
    setMessage(
      json.ok
        ? `Sync completo: ${json.importedTrades} operaciones nuevas, ${json.reconciled} ajustes de balance.`
        : `Fallo el sync: ${json.error}`,
    );
    mutate();
  }

  async function test(id: string) {
    setWorking(id);
    setMessage(null);
    const res = await fetch(`/api/accounts/${id}/test`, { method: "POST" });
    const json = await res.json();
    setWorking(null);
    setMessage(
      json.ok
        ? `Conexion correcta. ${json.assets} activos con saldo.`
        : `No conecta: ${json.error}`,
    );
  }

  async function remove(id: string) {
    setWorking(id);
    await fetch(`/api/accounts?id=${id}`, { method: "DELETE" });
    setWorking(null);
    mutate();
  }

  return (
    <>
      <PageTitle
        subtitle="Exchanges que se sincronizan solos y cuentas manuales"
        action={
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <Plus size={15} />
            Conectar cuenta
          </button>
        }
      >
        Cuentas
      </PageTitle>

      <Card className="mb-4 border-accent/25 bg-accent-dim/30">
        <div className="flex gap-3">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="text-sm">
            <p className="font-medium">Usa claves de solo lectura</p>
            <p className="mt-1 text-muted">
              La app solo llama a balance e historial, nunca a endpoints de
              trading ni de retiro. Aun asi, crea la API key sin permisos de
              trading ni de withdrawal. Se guardan cifradas con AES-256-GCM y
              nunca vuelven al navegador.
            </p>
          </div>
        </div>
      </Card>

      {adding && (
        <AccountForm
          exchanges={exchanges}
          onDone={() => {
            setAdding(false);
            mutate();
          }}
        />
      )}

      {message && (
        <Card className="mb-4">
          <p className="text-sm">{message}</p>
        </Card>
      )}

      {isLoading ? (
        <Card className="pulse-soft h-32" />
      ) : accounts.length === 0 ? (
        <EmptyState title="Ninguna cuenta conectada">
          Conecta Binance, Bybit, Kraken, OKX y otros con claves de solo
          lectura. Para brokers de bolsa, usa el import CSV desde la pestana de
          Cartera.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-center gap-3">
                <Plug size={16} className="text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    {a.exchangeId && <Badge tone="accent">{a.exchangeId}</Badge>}
                    {a.status === "active" ? (
                      <Badge tone="up">
                        <CheckCircle2 size={10} className="mr-1" />
                        activa
                      </Badge>
                    ) : (
                      <Badge tone="down">
                        <XCircle size={10} className="mr-1" />
                        error
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-faint">
                    {a.apiKeyMasked && `key ${a.apiKeyMasked} · `}
                    {a.lastSyncAt
                      ? `ultimo sync ${fmtDateTime(a.lastSyncAt)}`
                      : "sin sincronizar todavia"}
                  </p>
                </div>

                {a.type === "exchange" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => test(a.id)}
                      disabled={working === a.id}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-border-strong disabled:opacity-50"
                    >
                      Probar
                    </button>
                    <button
                      onClick={() => sync(a.id)}
                      disabled={working === a.id}
                      className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs transition hover:bg-border disabled:opacity-50"
                    >
                      <RefreshCw
                        size={12}
                        className={working === a.id ? "animate-spin" : ""}
                      />
                      {working === a.id ? "Sincronizando..." : "Sincronizar"}
                    </button>
                  </div>
                )}

                <button
                  onClick={() => remove(a.id)}
                  aria-label={`Eliminar ${a.name}`}
                  className="text-faint transition hover:text-down"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {a.lastError && (
                <p className="mt-3 rounded-lg bg-down-dim/40 p-2.5 text-xs text-down">
                  {a.lastError}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function AccountForm({
  exchanges,
  onDone,
}: {
  exchanges: Exchange[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [exchangeId, setExchangeId] = useState(exchanges[0]?.id ?? "binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = exchanges.find((e) => e.id === exchangeId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name || selected?.name || exchangeId,
        type: "exchange",
        exchangeId,
        apiKey,
        apiSecret,
        apiPassphrase: apiPassphrase || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo guardar");
      return;
    }
    onDone();
  }

  return (
    <Card className="mb-4">
      <CardTitle>Nueva cuenta de exchange</CardTitle>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="ex">
              Exchange
            </label>
            <select
              id="ex"
              value={exchangeId}
              onChange={(e) => setExchangeId(e.target.value)}
              className={field}
            >
              {exchanges.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="acc-name">
              Nombre
            </label>
            <input
              id="acc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={selected?.name ?? "Mi cuenta"}
              className={field}
            />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="api-key">
            API key
          </label>
          <input
            id="api-key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            className={`${field} font-mono`}
          />
        </div>

        <div>
          <label className={label} htmlFor="api-secret">
            API secret
          </label>
          <input
            id="api-secret"
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            autoComplete="off"
            className={`${field} font-mono`}
          />
        </div>

        {selected?.needsPassphrase && (
          <div>
            <label className={label} htmlFor="api-pass">
              Passphrase
            </label>
            <input
              id="api-pass"
              type="password"
              value={apiPassphrase}
              onChange={(e) => setApiPassphrase(e.target.value)}
              autoComplete="off"
              className={`${field} font-mono`}
            />
            <p className="mt-1 text-xs text-faint">
              {selected.name} exige passphrase ademas de key y secret.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !apiKey || !apiSecret}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Guardando..." : "Guardar y cifrar"}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong"
          >
            Cancelar
          </button>
        </div>
      </form>
    </Card>
  );
}
