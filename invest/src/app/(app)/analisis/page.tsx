"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, FileText, Send, ShieldAlert, User } from "lucide-react";
import { AssetSearch } from "@/components/asset-search";
import { Card, PageTitle } from "@/components/ui";
import type { SearchHit } from "@/lib/market/types";
import { api } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Como esta repartida mi cartera ahora mismo?",
  "Que posicion me esta costando mas dinero y por que?",
  "Cuanto peso tengo en cripto frente a bolsa?",
  "Que noticias recientes afectan a lo que tengo?",
];

export default function AnalisisPage() {
  const [tab, setTab] = useState<"chat" | "riesgo" | "tesis">("chat");

  return (
    <>
      <PageTitle subtitle="Analisis sobre tu cartera real, no consejos de inversion">
        Analisis IA
      </PageTitle>

      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1">
        {(
          [
            ["chat", "Chat", Bot],
            ["riesgo", "Riesgo", ShieldAlert],
            ["tesis", "Tesis", FileText],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition ${
              tab === key
                ? "bg-surface-2 font-medium"
                : "text-muted hover:text-text"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {tab === "chat" && <Chat />}
      {tab === "riesgo" && <RiskPanel />}
      {tab === "tesis" && <ThesisPanel />}
    </>
  );
}

function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    if (!text.trim() || streaming) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      const res = await fetch(api("/api/ai/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, threadId }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `El modelo respondio ${res.status}`);
      }

      const newThread = res.headers.get("x-thread-id");
      if (newThread) setThreadId(newThread);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Acumulamos dentro del updater en vez de en una variable externa:
        // sin estado compartido mutable y sin depender del orden de renders.
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = {
            role: "assistant",
            content: last.content + chunk,
          };
          return copy;
        });
      }
    } catch (e) {
      setError((e as Error).message);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <Card padded={false} className="flex h-[calc(100vh-16rem)] min-h-96 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Bot size={26} className="text-faint" />
            <p className="text-sm text-muted">
              Pregunta lo que quieras sobre tu cartera. El modelo ve tus
              posiciones, tu P&L y las noticias guardadas.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className="fade-up flex gap-3">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                m.role === "user" ? "bg-surface-2" : "bg-accent-dim"
              }`}
            >
              {m.role === "user" ? (
                <User size={13} className="text-muted" />
              ) : (
                <Bot size={13} className="text-accent" />
              )}
            </div>
            <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">
              {m.content ||
                (streaming && i === messages.length - 1 ? (
                  <span className="pulse-soft text-faint">Pensando...</span>
                ) : null)}
            </div>
          </div>
        ))}

        {error && <p className="text-sm text-down">{error}</p>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pregunta sobre tu cartera..."
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-accent"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          aria-label="Enviar"
          className="rounded-lg bg-accent px-3.5 text-white transition hover:opacity-90 disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </form>
    </Card>
  );
}

function RiskPanel() {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch(api("/api/ai/risk"), { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "No se pudo generar el analisis");
      return;
    }
    setAnalysis(data.analysis);
  }

  return (
    <Card>
      <p className="text-sm text-muted">
        Analisis de concentracion, correlacion aparente y exposicion por clase
        sobre tus posiciones actuales.
      </p>
      <button
        onClick={run}
        disabled={busy}
        className="mt-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "Analizando..." : "Analizar riesgo"}
      </button>

      {error && <p className="mt-4 text-sm text-down">{error}</p>}
      {analysis && (
        <div className="fade-up mt-5 whitespace-pre-wrap border-t border-border pt-5 text-sm leading-relaxed">
          {analysis}
        </div>
      )}
    </Card>
  );
}

function ThesisPanel() {
  const [asset, setAsset] = useState<SearchHit | null>(null);
  const [thesis, setThesis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function generate(hit: SearchHit) {
    setAsset(hit);
    setThesis(null);
    setSaved(false);
    setBusy(true);
    const res = await fetch(api("/api/ai/thesis"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: hit.symbol, assetClass: hit.assetClass }),
    });
    const data = await res.json();
    setBusy(false);
    setThesis(res.ok ? data.thesis : (data.error ?? "Error"));
  }

  async function save() {
    if (!asset || !thesis) return;
    await fetch(api("/api/ai/thesis"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: asset.symbol,
        assetClass: asset.assetClass,
        thesis,
      }),
    });
    setSaved(true);
  }

  return (
    <Card>
      <p className="mb-3 text-sm text-muted">
        Genera una tesis estructurada con caso alcista, caso bajista y que
        vigilar. Guardala para que el chat la tenga en cuenta despues.
      </p>
      <AssetSearch onPick={generate} placeholder="Elige un activo..." />

      {busy && (
        <p className="pulse-soft mt-5 text-sm text-faint">
          Escribiendo la tesis de {asset?.symbol}...
        </p>
      )}

      {thesis && (
        <div className="fade-up mt-5 border-t border-border pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-medium">{asset?.symbol}</h3>
            <button
              onClick={save}
              disabled={saved}
              className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-border-strong disabled:opacity-50"
            >
              {saved ? "Guardada" : "Guardar tesis"}
            </button>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {thesis}
          </div>
        </div>
      )}
    </Card>
  );
}
