"use client";

import useSWR from "swr";
import { useState, type FormEvent } from "react";
import {
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { Badge, Card, EmptyState, PageTitle } from "@/components/ui";
import type { ChangeKind, ManagerSyncResult, ManagerView, TrackedTag } from "@/lib/managers";
import { api, cn, fmtDate } from "@/lib/utils";

type Hit = { cik: string; name: string };
type Change = NonNullable<ManagerView["latest"]>["changes"][number];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Misma escala que en los hechos de las alertas ($1.2B / $45.6M). */
function usd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function quarter(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return `Q${Math.ceil(m / 3)} ${y}`;
}

const KIND: Record<ChangeKind, { label: string; tone: "up" | "down" | "accent" | "warn" }> = {
  new: { label: "Entra", tone: "up" },
  increase: { label: "Sube", tone: "up" },
  decrease: { label: "Baja", tone: "warn" },
  exit: { label: "Sale", tone: "down" },
};

function TrackedBadge({ tag }: { tag: TrackedTag }) {
  if (tag === "portfolio") return <Badge tone="accent">Cartera</Badge>;
  if (tag === "watchlist") return <Badge tone="accent">Watchlist</Badge>;
  if (tag === "known") return <Badge>Conocido</Badge>;
  return null;
}

function summarize(results: ManagerSyncResult[]): string {
  const done = results.filter((r) => !r.skipped);
  const filings = done.reduce((a, r) => a + r.filings, 0);
  const changes = done.reduce((a, r) => a + r.changes, 0);
  const events = done.reduce((a, r) => a + r.events, 0);
  const errors = done.filter((r) => r.error);
  const skipped = results.length - done.length;
  const parts = [
    `${done.length} gestor${done.length === 1 ? "" : "es"} revisado${done.length === 1 ? "" : "s"}`,
    `${filings} 13F nuevo${filings === 1 ? "" : "s"}`,
    `${changes} cambio${changes === 1 ? "" : "s"}`,
    `${events} alerta${events === 1 ? "" : "s"}`,
  ];
  if (skipped > 0) parts.push(`${skipped} sin tiempo (siguiente pasada)`);
  if (errors.length > 0) parts.push(`${errors.length} con error`);
  return parts.join(" · ");
}

export default function ManagersPage() {
  const { data, mutate, isLoading } = useSWR<{ managers: ManagerView[] }>(
    api("/api/managers"),
    fetcher,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showTop, setShowTop] = useState<Record<string, boolean>>({});
  const [watchBusy, setWatchBusy] = useState<string | null>(null);

  const list = data?.managers ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setMessage(null);
    if (/^\d{1,10}$/.test(q)) {
      await add(q);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(api(`/api/managers/search?q=${encodeURIComponent(q)}`));
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "No se pudo buscar en EDGAR");
      setHits(json.hits ?? []);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Error buscando", error: true });
    } finally {
      setSearching(false);
    }
  }

  async function add(cik: string) {
    setAdding(cik);
    setMessage(null);
    try {
      const res = await fetch(api("/api/managers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cik }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "No se pudo anadir");
      const sync = json.sync as ManagerSyncResult;
      setMessage({
        text: sync.error
          ? `${sync.manager} anadido, pero la descarga fallo: ${sync.error}`
          : `${sync.manager}: ${sync.filings} 13F descargado${sync.filings === 1 ? "" : "s"}, ${sync.changes} cambio${sync.changes === 1 ? "" : "s"}, ${sync.events} alerta${sync.events === 1 ? "" : "s"} sobre activos que sigues.`,
        error: Boolean(sync.error),
      });
      setHits(null);
      setQuery("");
      await mutate();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Error anadiendo", error: true });
    } finally {
      setAdding(null);
    }
  }

  async function syncAll() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch(api("/api/managers/sync"), { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "La pasada fallo");
      setMessage({ text: summarize(json.results as ManagerSyncResult[]) });
      await mutate();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Error", error: true });
    } finally {
      setSyncing(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch(api("/api/managers"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    await mutate();
  }

  async function remove(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    await fetch(api(`/api/managers?id=${encodeURIComponent(id)}`), { method: "DELETE" });
    await mutate();
  }

  async function watch(c: Change) {
    if (!c.ticker) return;
    setWatchBusy(c.cusip);
    try {
      await fetch(api("/api/watchlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.ticker,
          assetClass: "equity",
          providerId: c.ticker,
          name: c.issuer,
        }),
      });
      await mutate();
    } finally {
      setWatchBusy(null);
    }
  }

  return (
    <>
      <PageTitle
        subtitle="Lo que compran y venden los gestores que sigues, segun sus 13F. Ideas con firma y fecha, nunca ordenes."
        action={
          <button
            onClick={syncAll}
            disabled={syncing || list.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Buscando 13F..." : "Buscar 13F nuevos"}
          </button>
        }
      >
        Inversores
      </PageTitle>

      <Card className="mb-4">
        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (hits) setHits(null);
              }}
              placeholder="Nombre del gestor (Berkshire Hathaway, Pershing Square...) o su CIK"
              className="w-full rounded-lg border border-border bg-bg py-2 pl-9 pr-3 text-sm outline-none transition focus:border-border-strong"
            />
          </div>
          <button
            type="submit"
            disabled={searching || adding !== null || query.trim().length < 2}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {searching ? "Buscando..." : adding ? "Anadiendo..." : /^\d+$/.test(query.trim()) ? "Anadir" : "Buscar"}
          </button>
        </form>

        {hits && (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {hits.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted">
                EDGAR no encuentra nada con ese nombre. Prueba con el nombre legal del fondo o pega el CIK.
              </li>
            )}
            {hits.map((h) => (
              <li key={h.cik} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{h.name}</p>
                  <p className="text-xs text-faint">CIK {h.cik}</p>
                </div>
                <button
                  onClick={() => add(h.cik)}
                  disabled={adding !== null}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-border-strong disabled:opacity-40"
                >
                  {adding === h.cik ? "Descargando 13F..." : "Seguir"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {adding && !hits && (
          <p className="mt-3 text-xs text-muted">
            Verificando en EDGAR y descargando sus dos ultimos 13F. Puede tardar un minuto.
          </p>
        )}
        {message && (
          <p className={cn("mt-3 text-sm", message.error ? "text-down" : "text-muted")}>{message.text}</p>
        )}
      </Card>

      {isLoading ? (
        <Card className="pulse-soft h-40" />
      ) : list.length === 0 ? (
        <EmptyState title="Todavia no sigues a ningun gestor">
          Cualquier fondo con mas de $100M en acciones de EE. UU. publica su cartera cada trimestre en la SEC.
          Busca uno por nombre y veras lo que compra y vende; si toca un activo que sigues, aparece en Alertas.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {list.map((v) => (
            <ManagerCard
              key={v.manager.id}
              view={v}
              confirmDelete={confirmDelete === v.manager.id}
              showTop={Boolean(showTop[v.manager.id])}
              watchBusy={watchBusy}
              onToggleTop={() => setShowTop((s) => ({ ...s, [v.manager.id]: !s[v.manager.id] }))}
              onToggle={() => toggle(v.manager.id, !v.manager.enabled)}
              onRemove={() => remove(v.manager.id)}
              onWatch={watch}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-xs text-faint">
        Fuente: formularios 13F-HR en SEC EDGAR. Reflejan posiciones a cierre de trimestre, llegan con hasta 45 dias de
        retraso, solo cubren acciones y ETF de EE. UU. (sin cortos ni el motivo de cada operacion), y aqui se excluyen
        opciones y bonos. El ticker sale de OpenFIGI a partir del CUSIP; si no se resuelve, se muestra el emisor.
      </p>
    </>
  );
}

function ManagerCard({
  view,
  confirmDelete,
  showTop,
  watchBusy,
  onToggleTop,
  onToggle,
  onRemove,
  onWatch,
}: {
  view: ManagerView;
  confirmDelete: boolean;
  showTop: boolean;
  watchBusy: string | null;
  onToggleTop: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onWatch: (c: Change) => void;
}) {
  const { manager: m, latest, top } = view;
  const canWatch = (c: Change) => c.ticker && c.tracked !== "portfolio" && c.tracked !== "watchlist";

  return (
    <Card className={cn(!m.enabled && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{m.name}</h2>
            {!m.enabled && <Badge>Pausado</Badge>}
            {m.lastError && <Badge tone="warn">Error en la ultima pasada</Badge>}
          </div>
          <p className="mt-1 text-xs text-faint">
            CIK {m.cik}
            {latest && (
              <>
                {" · "}
                {quarter(latest.period)} presentado el {fmtDate(latest.filedAt)}
                {" · "}
                {usd(latest.totalValue)} en {latest.positions} posiciones
                {" · "}
                {view.filings} 13F guardado{view.filings === 1 ? "" : "s"}
              </>
            )}
            {m.lastSyncAt && <> · revisado {fmtDate(m.lastSyncAt)}</>}
          </p>
          {m.lastError && <p className="mt-1 text-xs text-warn">{m.lastError}</p>}
        </div>
        <div className="flex items-center gap-1">
          {latest && (
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-2 hover:text-text"
            >
              <ExternalLink size={13} /> EDGAR
            </a>
          )}
          <button
            onClick={onToggle}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-2 hover:text-text"
          >
            {m.enabled ? <Pause size={13} /> : <Play size={13} />}
            {m.enabled ? "Pausar" : "Reanudar"}
          </button>
          <button
            onClick={onRemove}
            className={cn(
              "flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition hover:bg-surface-2",
              confirmDelete ? "text-down" : "text-muted hover:text-down",
            )}
          >
            <Trash2 size={13} />
            {confirmDelete ? "Confirmar" : "Quitar"}
          </button>
        </div>
      </div>

      {!latest ? (
        <p className="mt-4 text-sm text-muted">
          Sin 13F descargados todavia. Pulsa &quot;Buscar 13F nuevos&quot; o revisa el error de arriba.
        </p>
      ) : (
        <>
          <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-faint">
            Cambios en {quarter(latest.period)} frente al trimestre anterior
          </h3>
          {latest.changes.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              {view.filings < 2
                ? "Primer 13F guardado: los cambios aparecen cuando haya dos trimestres que comparar."
                : "Sin entradas, salidas ni variaciones grandes en las posiciones relevantes."}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {latest.changes.map((c) => {
                const k = KIND[c.kind];
                return (
                  <li key={c.cusip} className="flex flex-wrap items-center gap-2 py-2.5">
                    <Badge tone={k.tone} className="min-w-14 justify-center whitespace-nowrap">
                      {k.label}
                      {c.deltaPct !== null && ` ${c.deltaPct > 0 ? "+" : ""}${Math.round(c.deltaPct)}%`}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        <span className="font-medium">{c.ticker ?? c.issuer}</span>
                        {c.ticker && <span className="ml-2 text-xs text-faint">{c.issuer}</span>}
                      </p>
                      <p className="tnum text-xs text-muted">
                        {c.kind === "exit"
                          ? `era el ${c.prevPct.toFixed(1)}% de su cartera (${c.prevShares.toLocaleString("en-US")} acciones)`
                          : `${c.pct.toFixed(1)}% de su cartera · ${usd(c.value)} · ${c.shares.toLocaleString("en-US")} acciones`}
                        {(c.kind === "increase" || c.kind === "decrease") && ` · antes ${c.prevPct.toFixed(1)}%`}
                      </p>
                    </div>
                    <TrackedBadge tag={c.tracked} />
                    {canWatch(c) && (
                      <button
                        onClick={() => onWatch(c)}
                        disabled={watchBusy === c.cusip}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition hover:border-border-strong hover:text-text disabled:opacity-40"
                      >
                        <Star size={12} />
                        {watchBusy === c.cusip ? "Anadiendo..." : "Watchlist"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <button
            onClick={onToggleTop}
            className="mt-4 text-xs text-muted transition hover:text-text"
          >
            {showTop ? "Ocultar" : "Ver"} las {top.length} mayores posiciones
          </button>
          {showTop && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-faint">
                  <tr>
                    <th className="py-1.5 font-medium">Posicion</th>
                    <th className="py-1.5 text-right font-medium">% cartera</th>
                    <th className="py-1.5 text-right font-medium">Valor</th>
                    <th className="py-1.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {top.map((h) => (
                    <tr key={h.cusip}>
                      <td className="py-1.5">
                        <span className="font-medium">{h.ticker ?? h.issuer}</span>
                        {h.ticker && <span className="ml-2 text-xs text-faint">{h.issuer}</span>}
                      </td>
                      <td className="tnum py-1.5 text-right">{h.pct.toFixed(1)}%</td>
                      <td className="tnum py-1.5 text-right">{usd(h.value)}</td>
                      <td className="py-1.5 text-right">
                        <TrackedBadge tag={h.tracked} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
