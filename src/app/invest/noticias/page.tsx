"use client";

import useSWR from "swr";
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Badge, Card, EmptyState, PageTitle } from "@/components/ui";
import type { NewsRow } from "@/db/schema";
import { api, fmtDateTime } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const SENTIMENT: Record<string, { label: string; tone: "up" | "down" | "neutral" }> = {
  bullish: { label: "Alcista", tone: "up" },
  bearish: { label: "Bajista", tone: "down" },
  neutral: { label: "Neutral", tone: "neutral" },
};

export default function NoticiasPage() {
  const { data, mutate, isLoading } = useSWR<{
    news: NewsRow[];
    lastError?: { at: number; message: string } | null;
  }>(api("/api/news"), fetcher);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "high">("all");

  async function refresh() {
    setRefreshing(true);
    const res = await fetch(api("/api/news"), { method: "POST" });
    const json = await res.json();
    mutate(json, false);
    setRefreshing(false);
  }

  const all = data?.news ?? [];
  const news = filter === "high" ? all.filter((n) => n.impact === "high") : all;

  return (
    <>
      <PageTitle
        subtitle="Titulares de tus activos, resumidos y clasificados por IA"
        action={
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm transition hover:border-border-strong disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Actualizando..." : "Actualizar"}
          </button>
        }
      >
        Noticias
      </PageTitle>

      <div className="mb-4 flex gap-2">
        {(["all", "high"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              filter === f
                ? "bg-surface-2 font-medium"
                : "text-muted hover:text-text"
            }`}
          >
            {f === "all" ? `Todas (${all.length})` : "Solo impacto alto"}
          </button>
        ))}
      </div>

      {data?.lastError?.message && (
        <Card className="mb-4 border-warn/40 text-sm">
          <p className="font-medium text-warn">El resumen con IA esta fallando</p>
          <p className="mt-1 break-words text-muted">{data.lastError.message}</p>
          <p className="mt-1 text-xs text-faint">
            {fmtDateTime(data.lastError.at)} · Sin resumen, el motor de alertas no analiza estas noticias.
            Revisa el modelo rapido en Ajustes.
          </p>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="pulse-soft h-24" />
          ))}
        </div>
      ) : news.length === 0 ? (
        <EmptyState title="Sin noticias todavia">
          Dale a Actualizar. Se buscan titulares de los activos que tengas en
          cartera o en la watchlist.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {news.map((n) => {
            const tickers = JSON.parse(n.tickers) as string[];
            const s = n.sentiment ? SENTIMENT[n.sentiment] : null;
            return (
              <li key={n.id}>
                <Card className="transition hover:border-border-strong">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {s && <Badge tone={s.tone}>{s.label}</Badge>}
                    {n.impact === "high" && <Badge tone="warn">Impacto alto</Badge>}
                    {n.kind === "filing" && <Badge tone="up">SEC</Badge>}
                    {tickers.slice(0, 4).map((t) => (
                      <Badge key={t} tone="accent">
                        {t}
                      </Badge>
                    ))}
                    <span className="ml-auto text-xs text-faint">
                      {n.source} · {fmtDateTime(n.publishedAt)}
                    </span>
                  </div>

                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 font-medium leading-snug hover:text-accent"
                  >
                    {n.headline}
                    <ExternalLink
                      size={13}
                      className="mt-1 shrink-0 opacity-0 transition group-hover:opacity-60"
                    />
                  </a>

                  {n.summary && (
                    <p className="mt-2 text-sm text-muted">{n.summary}</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
