"use client";

import useSWR from "swr";
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Badge, Card, EmptyState, PageTitle } from "@/components/ui";
import type { EventWithSources, RunStats } from "@/lib/intel/run";
import {
  EVENT_TYPE_LABELS,
  HORIZON_LABELS,
  PRIORITY_LABELS,
  type Feedback,
  type Priority,
} from "@/lib/intel/types";
import { api, cn, fmtDateTime } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
  const { data, mutate, isLoading } = useSWR<{ events: EventWithSources[] }>(
    api(`/api/events?min=${min}`),
    fetcher,
  );
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunStats | null>(null);

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch(api("/api/events"), { method: "POST" });
      const json = (await res.json()) as { stats?: RunStats; error?: string };
      if (json.stats) setLastRun(json.stats);
      await mutate();
    } finally {
      setRunning(false);
    }
  }

  async function sendFeedback(id: string, feedback: Feedback | null) {
    await fetch(api("/api/events"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, feedback }),
    });
    await mutate();
  }

  const list = data?.events ?? [];

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
        {lastRun && (
          <span className="ml-auto text-xs text-faint">
            Ultima pasada: {lastRun.scanned} noticias, {lastRun.clusters} hechos,{" "}
            {lastRun.created} eventos nuevos, {lastRun.noise} ruido
            {lastRun.deferred > 0 ? `, ${lastRun.deferred} pendientes` : ""}
          </span>
        )}
      </div>

      {lastRun?.error && (
        <Card className="mb-4 border-warn/40 text-sm">
          <p className="font-medium text-warn">El modelo no respondio bien</p>
          <p className="mt-1 break-words text-muted">{lastRun.error}</p>
          <p className="mt-1 text-xs text-faint">
            Si dice que el modelo no existe o no soporta salida estructurada, cambia el modelo
            de analisis en Ajustes. Las noticias pendientes se reintentan en la siguiente pasada.
          </p>
        </Card>
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
  event: EventWithSources;
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
        {ev.assessment && <Block label="Evaluacion IA">{ev.assessment}</Block>}
      </dl>

      {ev.sources.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {ev.sources.map((s) => (
            <li key={s.id}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-start gap-1 text-muted hover:text-accent"
              >
                <span className="shrink-0 text-faint">T{s.tier} · {s.source ?? "fuente"} ·</span>
                <span className="leading-snug">{s.headline}</span>
                <ExternalLink size={11} className="mt-0.5 shrink-0 opacity-0 transition group-hover:opacity-60" />
              </a>
            </li>
          ))}
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
            {ev.model} · {ev.promptVersion}
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
