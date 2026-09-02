"use client";

import useSWR from "swr";
import { useState } from "react";
import { Check, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import { AssetSearch } from "@/components/asset-search";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { ThesisAssumption, ThesisChange } from "@/db/schema";
import type { SearchHit } from "@/lib/market/types";
import type { AssumptionStatus, ProposalPayload, ThesisStructure, ThesisView } from "@/lib/thesis";
import { api, cn, fmtDate, fmtDateTime } from "@/lib/utils";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

type View = ThesisView & { fundamentalsText: string };

const STATUS: Record<AssumptionStatus, { label: string; tone: "up" | "warn" | "down" | "neutral" }> = {
  on_track: { label: "En linea", tone: "up" },
  at_risk: { label: "En riesgo", tone: "warn" },
  broken: { label: "Roto", tone: "down" },
  unknown: { label: "Sin evidencia", tone: "neutral" },
};
const STATUS_ORDER: AssumptionStatus[] = ["unknown", "on_track", "at_risk", "broken"];

async function json<T>(url: string, init: RequestInit): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetch(api(url), {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, data };
}

export function ThesisPanel({ focusPending = false }: { focusPending?: boolean }) {
  const { data, error, mutate, isLoading } = useSWR<{ theses: View[] }>(api("/api/theses"), fetcher);
  const [draft, setDraft] = useState<{ asset: SearchHit; structure: ThesisStructure; model: string; promptVersion: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function generate(hit: SearchHit) {
    setBusy(`Escribiendo la tesis de ${hit.symbol}...`);
    setMsg(null);
    setDraft(null);
    const { ok, data } = await json<{ structure: ThesisStructure; model: string; promptVersion: string }>("/api/theses", {
      method: "POST",
      body: JSON.stringify({ symbol: hit.symbol, assetClass: hit.assetClass }),
    });
    setBusy(null);
    if (!ok) {
      setMsg(data.error ?? "No se pudo generar la tesis");
      return;
    }
    setDraft({ asset: hit, structure: data.structure, model: data.model, promptVersion: data.promptVersion });
  }

  async function saveDraft(conviction: number) {
    if (!draft) return;
    setBusy("Guardando...");
    const { ok, data } = await json<{ ok: boolean }>("/api/theses", {
      method: "PUT",
      body: JSON.stringify({
        symbol: draft.asset.symbol,
        assetClass: draft.asset.assetClass,
        structure: draft.structure,
        conviction,
        generatedBy: draft.model,
        promptVersion: draft.promptVersion,
      }),
    });
    setBusy(null);
    if (!ok) {
      setMsg(data.error ?? "No se pudo guardar");
      return;
    }
    setDraft(null);
    setMsg(`Tesis de ${draft.asset.symbol} guardada.`);
    await mutate();
  }

  const list = data?.theses ?? [];
  const sorted = focusPending ? [...list].sort((a, b) => b.pending.length - a.pending.length) : list;

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm text-muted">
          Una tesis con supuestos medibles, condiciones que la romperian y que vigilar. Los eventos
          del motor de alertas proponen cambios sobre los supuestos; tu aceptas o rechazas.
        </p>
        <AssetSearch onPick={generate} placeholder="Generar o actualizar la tesis de..." />
        {busy && <p className="pulse-soft mt-4 text-sm text-faint">{busy}</p>}
        {msg && <p className="mt-4 text-sm text-muted">{msg}</p>}
        {draft && <DraftPreview draft={draft} onSave={saveDraft} onDiscard={() => setDraft(null)} />}
      </Card>

      {error && (
        <Card className="border-down/40 text-sm text-down">No se pudieron cargar las tesis ({String(error.message ?? error)}).</Card>
      )}

      {isLoading ? (
        <Card className="pulse-soft h-32" />
      ) : sorted.length === 0 ? (
        <EmptyState title="Todavia no hay tesis">
          Elige un activo arriba. La tesis sale con los fundamentales de Finnhub y los eventos recientes
          del motor, y se guarda con sus supuestos para contrastarla despues.
        </EmptyState>
      ) : (
        sorted.map((v) => <ThesisCard key={v.thesis.id} view={v} onChanged={() => mutate()} />)
      )}
    </div>
  );
}

function DraftPreview({
  draft,
  onSave,
  onDiscard,
}: {
  draft: { asset: SearchHit; structure: ThesisStructure; model: string };
  onSave: (conviction: number) => void;
  onDiscard: () => void;
}) {
  const [conviction, setConviction] = useState(3);
  const s = draft.structure;
  return (
    <div className="fade-up mt-5 border-t border-border pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{draft.asset.symbol}</h3>
        <Badge>{draft.asset.name}</Badge>
        <span className="ml-auto text-xs text-faint">borrador · {draft.model}</span>
      </div>
      <StructureBody structure={s} />
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <label className="text-xs text-muted">Conviccion inicial</label>
        <Conviction value={conviction} onChange={setConviction} />
        <button
          onClick={() => onSave(conviction)}
          className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Guardar tesis
        </button>
        <button onClick={onDiscard} className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:text-text">
          Descartar
        </button>
      </div>
    </div>
  );
}

function Conviction({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={cn(
            "h-7 w-7 rounded-md border text-xs transition",
            n <= value ? "border-accent/40 bg-accent-dim text-accent" : "border-border text-faint hover:text-text",
          )}
          aria-label={`Conviccion ${n}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function StructureBody({ structure: s, assumptions }: { structure: ThesisStructure; assumptions?: ThesisAssumption[] }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">{s.summary}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Block label="Caso alcista" items={s.bull} tone="up" />
        <Block label="Caso bajista" items={s.bear} tone="down" />
      </div>
      {!assumptions && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Supuestos</p>
          <ul className="mt-1 space-y-1">
            {s.assumptions.map((a, i) => (
              <li key={i} className="text-muted">
                <span className="text-text">{a.metric}:</span> {a.statement}
                {a.target !== null && (
                  <span className="text-faint">
                    {" "}
                    ({a.comparator === "lte" ? "≤" : "≥"} {a.target}
                    {a.unit ?? ""})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Block label="Que la rompe" items={s.breakers} />
      {s.watch.length > 0 && <Block label="Que vigilar" items={s.watch} />}
    </div>
  );
}

function Block({ label, items, tone }: { label: string; items: string[]; tone?: "up" | "down" }) {
  return (
    <div>
      <p className={cn("text-[11px] font-semibold uppercase tracking-wide", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-faint")}>
        {label}
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-muted">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThesisCard({ view: v, onChanged }: { view: View; onChanged: () => void }) {
  const [open, setOpen] = useState(v.pending.length > 0);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  async function setStatus(a: ThesisAssumption, status: AssumptionStatus) {
    setBusy(true);
    await json("/api/theses", {
      method: "PATCH",
      body: JSON.stringify({ thesisId: v.thesis.id, assumptions: [{ id: a.id, status, note: a.note }] }),
    });
    setBusy(false);
    onChanged();
  }

  async function setConviction(c: number) {
    setBusy(true);
    await json("/api/theses", { method: "PATCH", body: JSON.stringify({ thesisId: v.thesis.id, conviction: c }) });
    setBusy(false);
    onChanged();
  }

  async function resolve(change: ThesisChange, accept: boolean) {
    setBusy(true);
    await json("/api/theses/changes", { method: "POST", body: JSON.stringify({ id: change.id, accept }) });
    setBusy(false);
    onChanged();
  }

  const broken = v.assumptions.filter((a) => a.status === "broken").length;
  const atRisk = v.assumptions.filter((a) => a.status === "at_risk").length;

  return (
    <Card className={cn(busy && "opacity-70")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-2 text-left">
        <h3 className="font-medium">{v.asset.symbol}</h3>
        <span className="text-sm text-muted">{v.asset.name}</span>
        {v.thesis.conviction && <Badge tone="accent">conviccion {v.thesis.conviction}/5</Badge>}
        {broken > 0 && <Badge tone="down">{broken} roto{broken > 1 ? "s" : ""}</Badge>}
        {atRisk > 0 && <Badge tone="warn">{atRisk} en riesgo</Badge>}
        {v.pending.length > 0 && <Badge tone="warn">{v.pending.length} propuesta{v.pending.length > 1 ? "s" : ""}</Badge>}
        <span className="ml-auto flex items-center gap-2 text-xs text-faint">
          {fmtDate(v.thesis.updatedAt)}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {v.pending.map((c) => (
            <Proposal key={c.id} change={c} assumptions={v.assumptions} onResolve={(accept) => resolve(c, accept)} />
          ))}

          {v.fundamentalsText && (
            <p className="text-xs text-faint">
              <span className="font-semibold uppercase tracking-wide">Fundamentales</span> · {v.fundamentalsText}
            </p>
          )}

          {v.structure ? (
            <StructureBody structure={v.structure} assumptions={v.assumptions} />
          ) : (
            <pre className="whitespace-pre-wrap text-sm text-muted">{v.thesis.thesis}</pre>
          )}

          {v.assumptions.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Supuestos y estado</p>
              <ul className="mt-1 divide-y divide-border">
                {v.assumptions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start gap-2 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="text-text">{a.metric}:</span> <span className="text-muted">{a.statement}</span>
                      {a.note && <p className="mt-0.5 text-xs text-faint">{a.note}</p>}
                    </div>
                    <div className="flex gap-1">
                      {STATUS_ORDER.map((st) => (
                        <button
                          key={st}
                          onClick={() => setStatus(a, st)}
                          title={STATUS[st].label}
                          className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[11px] transition",
                            a.status === st ? badgeClass(STATUS[st].tone) : "border-border text-faint hover:text-text",
                          )}
                        >
                          {STATUS[st].label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <span className="text-xs text-muted">Conviccion</span>
            <Conviction value={v.thesis.conviction ?? 0} onChange={setConviction} />
            <button onClick={() => setShowHistory((s) => !s)} className="ml-auto text-xs text-faint hover:text-text">
              {showHistory ? "Ocultar historial" : `Historial (${v.history.length})`}
            </button>
          </div>

          {showHistory && (
            <ul className="space-y-1 text-xs text-faint">
              {v.history.map((h) => (
                <li key={h.id}>
                  {fmtDateTime(h.createdAt)} · {h.kind}
                  {h.status !== "applied" ? ` (${h.status})` : ""} · {h.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function badgeClass(tone: "up" | "warn" | "down" | "neutral"): string {
  switch (tone) {
    case "up":
      return "border-up/25 bg-up-dim text-up";
    case "down":
      return "border-down/25 bg-down-dim text-down";
    case "warn":
      return "border-warn/25 bg-warn/10 text-warn";
    default:
      return "border-border bg-surface-2 text-text";
  }
}

function Proposal({
  change,
  assumptions,
  onResolve,
}: {
  change: ThesisChange;
  assumptions: ThesisAssumption[];
  onResolve: (accept: boolean) => void;
}) {
  let payload: ProposalPayload | null = null;
  try {
    payload = JSON.parse(change.payload) as ProposalPayload;
  } catch {
    payload = null;
  }
  const byId = new Map(assumptions.map((a) => [a.id, a]));
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone="warn">Propuesta del motor</Badge>
        <span className="text-xs text-faint">{fmtDateTime(change.createdAt)}</span>
        {payload?.eventHeadline && <span className="text-xs text-muted">· {payload.eventHeadline}</span>}
      </div>
      <p>{change.summary}</p>
      {payload && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {payload.assumption_updates.map((u) => (
            <li key={u.id}>
              <span className="text-text">{byId.get(u.id)?.metric ?? "supuesto"}</span> → {STATUS[u.status]?.label ?? u.status}: {u.reason}
            </li>
          ))}
          {payload.breaker_hit && <li className="text-down">Condicion de ruptura cumplida{payload.breaker ? `: ${payload.breaker}` : ""}</li>}
          {payload.conviction_delta !== 0 && (
            <li>
              Conviccion {payload.conviction_delta > 0 ? "+" : ""}
              {payload.conviction_delta}
            </li>
          )}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <button onClick={() => onResolve(true)} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90">
          <Check size={12} /> Aceptar
        </button>
        <button onClick={() => onResolve(false)} className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text">
          <X size={12} /> Rechazar
        </button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-faint">
          <RefreshCw size={10} /> {payload?.model ?? ""}
        </span>
      </div>
    </div>
  );
}
