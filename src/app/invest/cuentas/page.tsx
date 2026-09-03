"use client";

import useSWR from "swr";
import { useState } from "react";
import {
  Building2,
  CheckCircle2,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge, Card, CardTitle, EmptyState, PageTitle } from "@/components/ui";
import { api, fmtDateTime } from "@/lib/utils";

type AccountRow = {
  id: string;
  name: string;
  type: string;
  exchangeId: string | null;
  flexQueryId: string | null;
  status: string;
  lastSyncAt: number | null;
  lastError: string | null;
  apiKeyMasked: string | null;
  hasCredentials: boolean;
};

type Exchange = { id: string; name: string; needsPassphrase: boolean };
type Broker = { id: string; name: string };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent";
const label = "mb-1.5 block text-xs text-muted";

export default function CuentasPage() {
  const { data, mutate, isLoading } = useSWR<{
    accounts: AccountRow[];
    supportedExchanges: Exchange[];
    supportedBrokers: Broker[];
  }>(api("/api/accounts"), fetcher);

  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const accounts = data?.accounts ?? [];

  async function sync(id: string) {
    setWorking(id);
    setMessage(null);
    const res = await fetch(api(`/api/accounts/${id}/sync`), { method: "POST" });
    const j = await res.json();
    setWorking(null);
    if (j.ok) {
      const parts = [`${j.importedTrades ?? 0} operaciones nuevas`];
      if (j.importedDividends) parts.push(`${j.importedDividends} dividendos`);
      if (j.importedCashFlows) parts.push(`${j.importedCashFlows} aportes/retiros`);
      if (j.reconciled) parts.push(`${j.reconciled} ajustes de saldo`);
      if (j.skipped) parts.push(`${j.skipped} filas sin soporte`);
      setMessage(`Sync completo: ${parts.join(", ")}.`);
    } else {
      setMessage(`Fallo el sync: ${j.error}`);
    }
    mutate();
  }

  async function test(id: string) {
    setWorking(id);
    setMessage(null);
    const res = await fetch(api(`/api/accounts/${id}/test`), { method: "POST" });
    const j = await res.json();
    setWorking(null);
    setMessage(j.ok ? `Conexion correcta. ${j.detail ?? ""}` : `No conecta: ${j.error}`);
  }

  async function remove(id: string) {
    setWorking(id);
    await fetch(api(`/api/accounts?id=${id}`), { method: "DELETE" });
    setWorking(null);
    mutate();
  }

  return (
    <>
      <PageTitle
        subtitle="Interactive Brokers para bolsa, exchanges para cripto"
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
            <p className="font-medium">Solo lectura, siempre</p>
            <p className="mt-1 text-muted">
              En exchanges, crea la API key sin permisos de trading ni de
              retiro: la app solo llama a balance e historial. En IBKR, el token
              de Flex Web Service es de lectura por diseno, no puede operar.
              Todo se guarda cifrado con AES-256-GCM y nunca vuelve al navegador.
            </p>
          </div>
        </div>
      </Card>

      {adding && (
        <AccountForm
          exchanges={data?.supportedExchanges ?? []}
          brokers={data?.supportedBrokers ?? []}
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
          Conecta Interactive Brokers con una Flex Query, y Binance u otro
          exchange con claves de solo lectura.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-center gap-3">
                {a.type === "broker" ? (
                  <Building2 size={16} className="text-faint" />
                ) : (
                  <Plug size={16} className="text-faint" />
                )}
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
                    {a.apiKeyMasked &&
                      `${a.type === "broker" ? "token" : "key"} ${a.apiKeyMasked} · `}
                    {a.flexQueryId && `query ${a.flexQueryId} · `}
                    {a.lastSyncAt
                      ? `ultimo sync ${fmtDateTime(a.lastSyncAt)}`
                      : "sin sincronizar todavia"}
                  </p>
                </div>

                {(a.type === "exchange" || a.type === "broker") && (
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
  brokers,
  onDone,
}: {
  exchanges: Exchange[];
  brokers: Broker[];
  onDone: () => void;
}) {
  const [kind, setKind] = useState<"broker" | "exchange">("broker");
  const [name, setName] = useState("");
  const [exchangeId, setExchangeId] = useState("binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [flexQueryId, setFlexQueryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = exchanges.find((e) => e.id === exchangeId);
  const brokerName = brokers[0]?.name ?? "Interactive Brokers";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const body =
      kind === "broker"
        ? {
            name: name || brokerName,
            type: "broker",
            exchangeId: "ibkr",
            apiKey,
            flexQueryId,
          }
        : {
            name: name || selected?.name || exchangeId,
            type: "exchange",
            exchangeId,
            apiKey,
            apiSecret,
            apiPassphrase: apiPassphrase || undefined,
          };

    const res = await fetch(api("/api/accounts"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo guardar");
      return;
    }
    onDone();
  }

  const canSubmit =
    kind === "broker" ? Boolean(apiKey && flexQueryId) : Boolean(apiKey && apiSecret);

  return (
    <Card className="mb-4">
      <CardTitle>Nueva cuenta</CardTitle>

      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1">
        {(
          [
            ["broker", "Broker (bolsa)"],
            ["exchange", "Exchange (cripto)"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`flex-1 rounded-md px-3 py-2 text-sm transition ${
              kind === k ? "bg-surface-2 font-medium" : "text-muted hover:text-text"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4">
        {kind === "broker" ? (
          <>
            <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
              <p className="mb-2 font-medium text-text">
                Como sacar esto de IBKR
              </p>
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Client Portal, menu{" "}
                  <span className="text-text">Performance &amp; Reports</span> y
                  luego <span className="text-text">Flex Queries</span>.
                </li>
                <li>
                  Crea una <span className="text-text">Activity Flex Query</span>{" "}
                  con las secciones <span className="text-text">Trades</span>,{" "}
                  <span className="text-text">Open Positions</span> y{" "}
                  <span className="text-text">Cash Transactions</span>. Formato
                  XML. Periodo: el que quieras cubrir.
                </li>
                <li>
                  Apunta el <span className="text-text">Query ID</span> que
                  aparece al lado de la query.
                </li>
                <li>
                  En el engranaje de{" "}
                  <span className="text-text">Flex Web Service</span>, activalo y
                  genera un token. No le pongas restriccion por IP: las
                  funciones de Vercel no tienen IP fija.
                </li>
              </ol>
            </div>

            <div>
              <label className={label} htmlFor="acc-name">
                Nombre
              </label>
              <input
                id="acc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={brokerName}
                className={field}
              />
            </div>

            <div>
              <label className={label} htmlFor="flex-token">
                Token de Flex Web Service
              </label>
              <input
                id="flex-token"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                placeholder="Cadena larga de numeros"
                className={`${field} font-mono`}
              />
            </div>

            <div>
              <label className={label} htmlFor="flex-query">
                Query ID
              </label>
              <input
                id="flex-query"
                value={flexQueryId}
                onChange={(e) => setFlexQueryId(e.target.value)}
                autoComplete="off"
                placeholder="Ej. 1234567"
                className={`${field} font-mono`}
              />
            </div>
          </>
        ) : (
          <>
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
                <label className={label} htmlFor="ex-name">
                  Nombre
                </label>
                <input
                  id="ex-name"
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

            {exchangeId === "binance" && (
              <p className="rounded-lg bg-warn/10 p-2.5 text-xs text-warn">
                Binance bloquea las IPs de Estados Unidos con un HTTP 451. El
                proyecto ya viene con la region de Vercel fijada a Frankfurt en
                vercel.json para evitarlo. No pongas whitelist de IP en la key:
                las funciones de Vercel no tienen IP fija.
              </p>
            )}
          </>
        )}

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !canSubmit}
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
