"use client";

import useSWR from "swr";
import Link from "next/link";
import { useState } from "react";
import { ExternalLink, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Badge, Card, EmptyState, PageTitle } from "@/components/ui";
import type { CalibrationReport } from "@/lib/intel/calibration";
import type { EventWithSources, RunStats } from "@/lib/intel/run";
import type { Weights } from "@/lib/intel/score";
import {
  EVENT_TYPE_LABELS,
  HORIZON_LABELS,
  PRIORITY_LABELS,
  type Feedback,
  type Priority,
} from "@/lib/intel/types";
import { api, cn, fmtDateTime } from "@/lib/utils";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Solo enlaces http(s): una URL rara de una fuente no se convierte en enlace. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function fmtRun(run: RunStats): string {
  const parts = [
    `${run.scanned} noticias`,
    `${run.clusters} hechos`,
    `${run.created} nuevos`,
    run.updated > 0 ? `${run.updated} actualizados` : "",
    run.attached > 0 ? `${run.attached} enganchados` : "",
    `${run.noise} ruido`,
    run.deferred > 0 ? `${run.deferred} pendientes` : "",
    run.unsummarized > 0 ? `${run.unsummarized} sin resumir` : "",
    run.abandoned > 0 ? `${run.abandoned} abandonadas` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

type Filter = "signals" | "all" | "noise";
const FILTERS: Array<{ id: Filter; label: string; min: Priority }> = [
  { id: "signals", label: "Senales", min: "P3" },
  { id: "all", label: "Con vigilancia", min: "P4" },
  { id: "noise", label: "Todo, ruido incluido", min: "P5" },
];

const PRIORITY_TONE: Record<Priority, "down" | "warn" | "accent" | "neutral"> = {
  P1: "down",
  P2: "warn",
  P3: "accent",
  P4: "neutral",
  P5: "neutral",
};

const FEEDBACK: Array<{ id: Feedback; label: string }> = [
  { id: "useful", label: "Util" },
  { id: "not_useful", label: "No util" },
  { id: "known", label: "Ya lo sabia" },
  { id: "speculative", label: "Especulativo" },
  { id: "late", label: "Tarde" },
  { id: "irrelevant", label: "Irrelevante" },
];

export default function AlertasPage() {
  const [filter, setFilter] = useState<Filter>("signals");
  const min = FILTERS.find((f) => f.id === filter)!.min;
  const { data, error, mutate, isLoading } = useSWR<{
    events: Array<EventWithSources & { proposalId: string | null }>;
    lastRun: RunStats | null;
  }>(api(`/api/events?min=${min}`), fetcher);
  const [showCalibration, setShowCalibration] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runNow() {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(api("/api/events"), { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setRunError(json.error ?? `La pasada fallo (HTTP ${res.status}).`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "No se pudo lanzar la pasada.");
    } finally {
      await mutate();
      setRunning(false);
    }
  }

  async function sendFeedback(id: string, feedback: Feedback | null) {
    try {
      await fetch(api("/api/events"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, feedback }),
      });
    } finally {
      await mutate();
    }
  }

  const list = data?.events ?? [];
  const lastRun = data?.lastRun ?? null;

  return (
    <>
      <PageTitle
        subtitle="Hechos que pueden mover una tesis. Hecho, inferencia y evaluacion, por separado y con fuentes."
        action={
          <button
            onClick={runNow}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong disabled:opacity-50"
          >
            <RefreshCw size={14} className={running ? "animate-spin" : ""} />
            {running ? "Analizando..." : "Analizar ahora"}
          </button>
        }
      >
        Alertas
      </PageTitle>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              filter === f.id ? "bg-surface-2 font-medium" : "text-muted hover:text-text",
            )}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => setShowCalibration((v) => !v)}
          className={cn(
            "flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm transition",
            showCalibration ? "bg-surface-2 font-medium" : "text-muted hover:text-text",
          )}
        >
          <SlidersHorizontal size={13} /> Calibracion
        </button>
        {lastRun && (
          <span className="ml-auto text-xs text-faint">
            Ultima pasada ({lastRun.trigger}, {fmtDateTime(lastRun.finishedAt)}): {fmtRun(lastRun)}
          </span>
        )}
      </div>

      {showCalibration && <CalibrationCard />}

      {(runError || error) && (
        <Card className="mb-4 border-down/40 text-sm">
          <p className="font-medium text-down">
            {runError ?? "No se pudo cargar el feed"}
          </p>
          {error && !runError && (
            <p className="mt-1 text-xs text-faint">{String(error.message ?? error)}</p>
          )}
        </Card>
      )}

      {lastRun?.error && (
        <Card className="mb-4 border-warn/40 text-sm">
          <p className="font-medium text-warn">El modelo no respondio bien en la ultima pasada</p>
          <p className="mt-1 break-words text-muted">{lastRun.error}</p>
          <p className="mt-1 text-xs text-faint">
            Si dice que el modelo no existe o no soporta salida estructurada, cambia el modelo
            de analisis en Ajustes. Lo pendiente se reintenta en la siguiente pasada; lo que
            falla tres veces se abandona.
          </p>
        </Card>
      )}

      {lastRun?.warning && !lastRun.error && (
        <p className="mb-4 text-xs text-faint">{lastRun.warning}</p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="pulse-soft h-40" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="Nada que merezca una alerta">
          {filter === "signals"
            ? "No hay eventos P1-P3. El motor corre solo cada 4 horas sobre las noticias de tus activos; tambien puedes lanzarlo ahora."
            : "Todavia no se ha analizado ninguna noticia. Dale a Analizar ahora."}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {list.map((ev) => (
            <li key={ev.id}>
              <EventCard event={ev} onFeedback={sendFeedback} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EventCard({
  event: ev,
  onFeedback,
}: {
  event: EventWithSources & { proposalId?: string | null };
  onFeedback: (id: string, feedback: Feedback | null) => Promise<void>;
}) {
  const priority = ev.priority as Priority;
  const impactTone = ev.thesisImpact > 0 ? "text-up" : ev.thesisImpact < 0 ? "text-down" : "text-muted";

  return (
    <Card className={cn("transition hover:border-border-strong", priority === "P5" && "opacity-70")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={PRIORITY_TONE[priority]}>
          {priority} · {PRIORITY_LABELS[priority]}
        </Badge>
        <Badge>{EVENT_TYPE_LABELS[ev.type as keyof typeof EVENT_TYPE_LABELS] ?? ev.type}</Badge>
        {ev.companies.slice(0, 4).map((c) => (
          <Badge key={c} tone="accent">
            {c}
          </Badge>
        ))}
        {ev.sourceTier === 4 && <Badge tone="warn">Fuente no verificada</Badge>}
        {ev.sourceTier === 1 && <Badge tone="up">Fuente primaria</Badge>}
        {ev.proposalId && (
          <Link href="/invest/analisis?tab=tesis&pending=1" className="inline-flex">
            <Badge tone="warn">Propuesta de tesis pendiente →</Badge>
          </Link>
        )}
        <span className="ml-auto text-xs text-faint">
          {fmtDateTime(ev.occurredAt)} · {ev.sources.length}{" "}
          {ev.sources.length === 1 ? "fuente" : "fuentes"}
        </span>
      </div>

      <p className="font-medium leading-snug">{ev.headline}</p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          Impacto en tesis{" "}
          <b className={impactTone}>
            {ev.thesisImpact > 0 ? "+" : ""}
            {ev.thesisImpact}
          </b>
        </span>
        <span>
          Horizonte <b className="text-text">{HORIZON_LABELS[ev.timeHorizon as keyof typeof HORIZON_LABELS] ?? ev.timeHorizon}</b>
        </span>
        <span>
          Materialidad <b className="text-text">{ev.materiality}</b>
        </span>
        <span>
          Confianza <b className="text-text">{ev.confidence}</b>
        </span>
        <span>
          Relevancia <b className="text-text">{ev.portfolioRelevance}</b>
        </span>
        <span>
          Score <b className="text-text">{ev.signalScore}</b>
        </span>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <Block label="Hecho">{ev.fact}</Block>
        {ev.inference && <Block label="Inferencia">{ev.inference}</Block>}
        {ev.assessment && <Block label={ev.model ? "Evaluacion IA" : "Evaluacion"}>{ev.assessment}</Block>}
      </dl>

      {ev.sources.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {ev.sources.map((s) => {
            const href = safeHref(s.url);
            const body = (
              <>
                <span className="shrink-0 text-faint">T{s.tier} · {s.source ?? "fuente"} ·</span>
                <span className="leading-snug">{s.headline}</span>
              </>
            );
            return (
              <li key={s.id}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-start gap-1 text-muted hover:text-accent"
                  >
                    {body}
                    <ExternalLink size={11} className="mt-0.5 shrink-0 opacity-0 transition group-hover:opacity-60" />
                  </a>
                ) : (
                  <span className="inline-flex items-start gap-1 text-muted">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <span className="mr-1 text-xs text-faint">Te sirvio?</span>
        {FEEDBACK.map((f) => {
          const active = ev.feedback === f.id;
          return (
            <button
              key={f.id}
              onClick={() => onFeedback(ev.id, active ? null : f.id)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] transition",
                active
                  ? "border-accent/40 bg-accent-dim text-accent"
                  : "border-border text-muted hover:border-border-strong hover:text-text",
              )}
            >
              {f.label}
            </button>
          );
        })}
        {ev.model && (
          <span className="ml-auto text-[11px] text-faint">
            {[ev.model, ev.promptVersion].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
    </Card>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line text-muted">{children}</dd>
    </div>
  );
}

const WEIGHT_LABELS: Record<keyof Weights, string> = {
  materiality: "Materialidad",
  confidence: "Confianza",
  thesisImpact: "Impacto en tesis",
  portfolioRelevance: "Relevancia cartera",
  sourceReliability: "Fiabilidad fuente",
};

function CalibrationCard() {
  const { data, error, mutate } = useSWR<CalibrationReport>(api("/api/intel/calibration"), fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(action: "suggest" | "reset") {
    setBusy(true);
    setMsg(null);
    const res = await fetch(api("/api/intel/calibration"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) setMsg(json.error ?? "No se pudo aplicar");
    await mutate();
    setBusy(false);
  }

  if (error) return <Card className="mb-4 text-sm text-down">No se pudo cargar la calibracion.</Card>;
  if (!data) return <Card className="mb-4 pulse-soft h-24" />;

  const keys = Object.keys(data.weights) as Array<keyof Weights>;
  return (
    <Card className="mb-4 text-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-medium">Calibracion con tu feedback</span>
        <span className="text-xs text-faint">
          {data.rated} de {data.total} eventos valorados
        </span>
        {data.customized && <Badge tone="accent">pesos personalizados</Badge>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Precision por prioridad</p>
          <table className="w-full text-xs">
            <tbody>
              {data.byPriority.map((p) => (
                <tr key={p.priority} className="border-t border-border">
                  <td className="py-1 font-medium">{p.priority}</td>
                  <td className="py-1 text-muted">{p.rated} valorados</td>
                  <td className="py-1 text-muted">{p.useful} utiles</td>
                  <td className="py-1 text-right">
                    {p.precision === null ? <span className="text-faint">—</span> : `${Math.round(p.precision * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Pesos del score</p>
          <table className="w-full text-xs">
            <tbody>
              {keys.map((k) => (
                <tr key={k} className="border-t border-border">
                  <td className="py-1">{WEIGHT_LABELS[k]}</td>
                  <td className="py-1 text-right tnum">{data.weights[k].toFixed(2)}</td>
                  <td className="py-1 text-right tnum text-faint">
                    {data.suggestion ? `→ ${data.suggestion[k].toFixed(2)}` : `(${data.defaultWeights[k].toFixed(2)})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 text-xs text-faint">{data.suggestionNote}</p>
      {msg && <p className="mt-1 text-xs text-down">{msg}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => act("suggest")}
          disabled={busy || !data.suggestion}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
        >
          Aplicar pesos sugeridos
        </button>
        <button
          onClick={() => act("reset")}
          disabled={busy || !data.customized}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-40"
        >
          Restaurar pesos por defecto
        </button>
      </div>
    </Card>
  );
}
