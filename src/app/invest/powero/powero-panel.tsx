"use client";

import { useState } from "react";
import useSWR from "swr";
import { Check, RefreshCw, X } from "lucide-react";
import type { Book, BookMark, Order } from "@/lib/powero";
import { MAX_SYMBOL_PCT, MAX_TICKET_PCT, minTicket } from "@/lib/powero";
import type { PoweroSettings } from "@/lib/powero-settings";
import { api, cn, fmtDate } from "@/lib/utils";

type State = {
  settings: PoweroSettings;
  marks: Record<Book, BookMark>;
  orders: Order[];
  pending: Order[];
  curve: Array<{ at: number; equity: number; book: string }>;
  asOf: number;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const money = (n: number) =>
  n.toLocaleString("es-ES", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
const BOOK_LABEL: Record<Book, string> = { equity: "Bolsa", crypto: "Cripto" };

/** Etiqueta pequeña en mayúsculas: el pegamento visual de toda la pantalla. */
function Label({ children }: { children: React.ReactNode }) {
  return <div className="label">{children}</div>;
}

/** Una celda de la tira de métricas. */
function Cell({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "up" | "down" }) {
  return (
    <div className="border-r border-border px-4 py-3 last:border-r-0">
      <Label>{label}</Label>
      <div
        className={cn(
          "figure mt-1 text-xl",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-faint">{hint}</div>}
    </div>
  );
}

/**
 * Curva de balance dibujada a mano en SVG. Sin librería: es una polilínea
 * sobre una rejilla, y así pesa cero y hereda el tema.
 */
function Curve({
  points,
  bench,
  initial,
}: {
  points: Array<{ at: number; equity: number }>;
  bench: Array<{ at: number; equity: number }>;
  initial: number;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center text-xs text-faint">
        La curva aparece con la segunda foto. El cron valora cada pocas horas.
      </div>
    );
  }
  const w = 1000;
  const h = 220;
  const xs = points.map((p) => p.at);
  const ys = [...points.map((p) => p.equity), ...bench.map((p) => p.equity)];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const lo = Math.min(...ys, initial);
  const hi = Math.max(...ys, initial);
  const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.02);
  const y0 = lo - pad;
  const y1 = hi + pad;
  const px = (x: number) => ((x - minX) / Math.max(1, maxX - minX)) * w;
  const py = (y: number) => h - ((y - y0) / Math.max(1e-9, y1 - y0)) * h;
  const path = (pts: Array<{ at: number; equity: number }>) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.at).toFixed(1)},${py(p.equity).toFixed(1)}`).join("");
  const line = path(points);
  const area = `${line}L${w},${h}L0,${h}Z`;
  const last = points[points.length - 1].equity;
  const up = last >= initial;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-56 w-full" preserveAspectRatio="none">
        <line x1="0" y1={py(initial)} x2={w} y2={py(initial)} stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" className="text-border-strong" />
        <path d={area} className={up ? "fill-up-dim" : "fill-down-dim"} />
        {/* El indice: la linea a batir. Gris y fina, pero siempre visible. */}
        {bench.length > 1 && (
          <path
            d={path(bench)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="5 3"
            className="text-faint"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" className={up ? "text-up" : "text-down"} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex flex-wrap justify-between gap-x-4 text-[10px] text-faint">
        <span>{fmtDate(minX)}</span>
        <span>
          <span className={up ? "text-up" : "text-down"}>—</span> el oráculo · <span>- - -</span> el índice
          (VOO/BTC) con el mismo dinero · capital inicial {money(initial)}
        </span>
        <span>{fmtDate(maxX)}</span>
      </div>
    </div>
  );
}

export function PoweroPanel() {
  const { data, error, isLoading, mutate } = useSWR<State>(api("/api/powero"), fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 60_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [capital, setCapital] = useState<{ equity: string; crypto: string } | null>(null);

  async function post(body: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setMsg(null);
    try {
      const res = await fetch(api("/api/powero"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string; created?: Order[] };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.created) {
        setMsg(json.created.length === 0 ? "Ninguna señal supera el umbral ahora mismo." : `${json.created.length} propuestas nuevas.`);
      }
      await mutate();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const marks = data?.marks;
  const total = marks ? marks.equity.equity + marks.crypto.equity : 0;
  const totalInitial = marks ? marks.equity.initial + marks.crypto.initial : 0;
  const totalPnl = total - totalInitial;
  const totalPct = totalInitial > 0 ? (totalPnl / totalInitial) * 100 : 0;
  const executed = (data?.orders ?? []).filter((o) => o.status === "executed");
  const wins = executed.filter((o) => o.side === "sell").length;
  // La cifra que responde "¿esto funciona?": cuánto le saca el oráculo a
  // haber metido el mismo dinero en el índice el mismo día y no tocarlo.
  const benchCurve = combineCurve(data?.curve ?? [], true);
  const benchNow = benchCurve.at(-1)?.equity ?? null;
  const vsBench =
    benchNow !== null && benchNow > 0 && totalInitial > 0
      ? (total / totalInitial - benchNow / totalInitial) * 100
      : null;

  return (
    <div className="space-y-px">
      {/* Cabecera: la cifra que importa, grande, y la tira de métricas. */}
      <div className="border border-border bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-6 p-5">
          <div>
            <Label>Patrimonio del libro · nocional</Label>
            <div className="figure mt-1 text-5xl sm:text-6xl">{money(total)}</div>
            <div className="mt-2 flex items-center gap-2">
              <span
                className={cn(
                  "px-1.5 py-0.5 text-xs font-medium",
                  totalPnl >= 0 ? "bg-up-dim text-up" : "bg-down-dim text-down",
                )}
              >
                {pct(totalPct)}
              </span>
              <span className="text-xs text-faint">
                {money(totalPnl)} sobre {money(totalInitial)} de capital
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 border-y border-l border-border sm:grid-cols-4">
            <Cell label="Operaciones" value={String(executed.length)} hint="apuntadas en el libro" />
            <Cell label="Cierres" value={String(wins)} hint="posiciones vendidas" />
            <Cell
              label="vs índice"
              value={vsBench === null ? "–" : pct(vsBench)}
              hint="contra comprar y esperar"
              tone={vsBench === null ? undefined : vsBench >= 0 ? "up" : "down"}
            />
            <Cell
              label="Modo"
              value={data?.settings.mode === "auto" ? "AUTO" : "MANUAL"}
              hint={data?.settings.mode === "auto" ? "apunta solo" : "decides tú"}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-2">
          <button
            onClick={() => post({ action: "propose" }, "propose")}
            disabled={busy !== null}
            className="flex items-center gap-1.5 border border-border-strong px-3 py-1.5 text-xs transition hover:bg-surface-2 disabled:opacity-40"
          >
            <RefreshCw size={11} className={cn(busy === "propose" && "animate-spin")} />
            {busy === "propose" ? "Leyendo el motor…" : "Buscar señales"}
          </button>
          <button
            onClick={() => post({ action: "mark" }, "mark")}
            disabled={busy !== null}
            className="border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-40"
          >
            Valorar ahora
          </button>
          <button
            onClick={() =>
              post({ action: "settings", mode: data?.settings.mode === "auto" ? "manual" : "auto" }, "mode")
            }
            disabled={busy !== null}
            className="border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-40"
          >
            {data?.settings.mode === "auto" ? "Volver a manual" : "Pasar a automático"}
          </button>
          {msg && <span className="text-xs text-muted">{msg}</span>}
          <span className="ml-auto text-[10px] text-faint">
            {isLoading ? "cargando…" : data ? `actualizado ${new Date(data.asOf).toLocaleTimeString("es-ES")}` : ""}
          </span>
        </div>
      </div>

      {error && <div className="border border-border bg-surface p-5 text-sm text-down">{(error as Error).message}</div>}

      {/* Curva */}
      <div className="border border-border bg-surface p-5">
        <div className="mb-2 flex items-center justify-between">
          <Label>Curva de balance · los dos libros</Label>
          <span className="text-[10px] text-faint">últimos 90 días</span>
        </div>
        <Curve
          points={combineCurve(data?.curve ?? [], false)}
          bench={combineCurve(data?.curve ?? [], true)}
          initial={totalInitial}
        />
      </div>

      {/* Los dos libros */}
      <div className="grid gap-px sm:grid-cols-2">
        {(["equity", "crypto"] as Book[]).map((book) => {
          const m = marks?.[book];
          return (
            <div key={book} className="border border-border bg-surface p-5">
              <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
                <Label>{BOOK_LABEL[book]}</Label>
                <span className={cn("text-xs", (m?.pnl ?? 0) >= 0 ? "text-up" : "text-down")}>
                  {m ? `${money(m.equity)} · ${pct(m.pnlPct)}` : "–"}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <span>
                  <span className="text-faint">efectivo</span> {m ? money(m.cash) : "–"}
                </span>
                <span>
                  <span className="text-faint">invertido</span> {m ? money(m.positionsValue) : "–"}
                </span>
                <span>
                  <span className="text-faint">ticket máx</span>{" "}
                  {m ? money((m.equity * MAX_TICKET_PCT) / 100) : "–"}
                </span>
                <span>
                  <span className="text-faint">ticket mín</span> {m ? money(minTicket(m.equity)) : "–"}
                </span>
              </div>

              {m && m.lines.length > 0 ? (
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-faint">
                      <th className="py-1 font-normal">Activo</th>
                      <th className="py-1 text-right font-normal">Uds</th>
                      <th className="py-1 text-right font-normal">Coste</th>
                      <th className="py-1 text-right font-normal">Valor</th>
                      <th className="py-1 text-right font-normal">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.lines.map((l) => (
                      <tr key={l.symbol} className="border-b border-border last:border-0">
                        <td className="py-1.5 font-semibold">{l.symbol}</td>
                        <td className="py-1.5 text-right text-muted">{l.qty.toFixed(l.qty < 1 ? 5 : 2)}</td>
                        <td className="py-1.5 text-right text-muted">{money(l.avgPrice)}</td>
                        <td className="py-1.5 text-right">{money(l.value)}</td>
                        <td className={cn("py-1.5 text-right", l.pnl >= 0 ? "text-up" : "text-down")}>
                          {pct(l.pnlPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-3 text-xs text-faint">Sin posiciones. Todo el capital en efectivo.</p>
              )}

              <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
                <input
                  type="number"
                  min={1}
                  placeholder={String(book === "equity" ? data?.settings.equityCapital ?? "" : data?.settings.cryptoCapital ?? "")}
                  value={book === "equity" ? capital?.equity ?? "" : capital?.crypto ?? ""}
                  onChange={(e) =>
                    setCapital((c) => ({
                      equity: book === "equity" ? e.target.value : c?.equity ?? "",
                      crypto: book === "crypto" ? e.target.value : c?.crypto ?? "",
                    }))
                  }
                  className="w-28 border border-border bg-surface-2 px-2 py-1 text-xs"
                />
                <button
                  onClick={() => {
                    const raw = book === "equity" ? capital?.equity : capital?.crypto;
                    const v = Number(raw);
                    if (!Number.isFinite(v) || v <= 0) return;
                    post(
                      { action: "settings", [book === "equity" ? "equityCapital" : "cryptoCapital"]: v },
                      `cap-${book}`,
                    );
                  }}
                  disabled={busy !== null}
                  className="border border-border px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40"
                >
                  Fijar capital
                </button>
                <button
                  onClick={() => post({ action: "reset", book }, `reset-${book}`)}
                  disabled={busy !== null}
                  className="ml-auto text-[10px] text-faint transition hover:text-down disabled:opacity-40"
                >
                  reiniciar libro
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Propuestas vivas */}
      {data && data.pending.length > 0 && (
        <div className="border border-border bg-surface">
          <div className="border-b border-border px-5 py-3">
            <Label>Esperando tu decisión · {data.pending.length}</Label>
            <p className="mt-1 text-[11px] text-faint">
              Aceptar apunta la operación en el libro de mentira. Comprar de verdad, si quieres, lo haces tú en
              tu broker.
            </p>
          </div>
          <ul className="divide-y divide-border">
            {data.pending.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-xs">
                <span className={cn("w-12 font-semibold", o.side === "buy" ? "text-up" : "text-down")}>
                  {o.side === "buy" ? "COMPRA" : "VENDE"}
                </span>
                <span className="w-16 font-semibold">{o.symbol}</span>
                <span className="w-20 text-right">{money(o.amount)}</span>
                <span className="w-24 text-right text-muted">{o.qty.toFixed(o.qty < 1 ? 5 : 2)} uds</span>
                <span className="w-20 text-right text-muted">a {money(o.price)}</span>
                <span className="min-w-40 flex-1 truncate text-faint" title={o.reason}>
                  {o.source} · {o.reason}
                </span>
                <span className="flex gap-1">
                  <button
                    onClick={() => post({ action: "decide", orderId: o.id, decision: "executed" }, o.id)}
                    disabled={busy !== null}
                    className="flex items-center gap-1 border border-border px-2 py-1 transition hover:bg-up-dim hover:text-up disabled:opacity-40"
                  >
                    <Check size={11} /> aceptar
                  </button>
                  <button
                    onClick={() => post({ action: "decide", orderId: o.id, decision: "discarded" }, o.id)}
                    disabled={busy !== null}
                    className="flex items-center gap-1 border border-border px-2 py-1 text-faint transition hover:text-down disabled:opacity-40"
                  >
                    <X size={11} /> descartar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Registro */}
      <div className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <Label>Registro de operaciones</Label>
          <span className="text-[10px] text-faint">{data?.orders.length ?? 0} en total</span>
        </div>
        {data && data.orders.length === 0 ? (
          <p className="px-5 py-4 text-xs text-faint">
            Vacío. Pulsa &quot;Buscar señales&quot;: lee el veredicto y la escalera cripto, y propone las
            operaciones dimensionadas a tu capital.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(data?.orders ?? []).slice(0, 40).map((o) => (
              <li
                key={o.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-1.5 text-[11px]",
                  o.status === "discarded" && "opacity-40",
                )}
              >
                <span className="w-24 text-faint">{fmtDate(o.decidedAt ?? o.proposedAt)}</span>
                <span className="w-16 text-faint">{BOOK_LABEL[o.book]}</span>
                <span className={cn("w-12", o.side === "buy" ? "text-up" : "text-down")}>
                  {o.side === "buy" ? "compra" : "vende"}
                </span>
                <span className="w-16 font-semibold">{o.symbol}</span>
                <span className="w-20 text-right">{money(o.amount)}</span>
                <span className="w-20 text-right text-muted">a {money(o.price)}</span>
                <span className="w-20 text-faint">{o.source}</span>
                <span className="ml-auto text-faint">
                  {o.status === "executed" ? "en el libro" : o.status === "discarded" ? "descartada" : "propuesta"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="px-1 pt-2 text-[10px] leading-relaxed text-faint">
        PoWERo no coloca órdenes. Ni en automático. Lleva un libro de mentira con tu capital nocional para medir
        si el motor acierta, con precios reales y sin arriesgar un dólar. Tope por idea {MAX_TICKET_PCT}% del
        libro, tope por activo {MAX_SYMBOL_PCT}%.
      </p>
    </div>
  );
}

/**
 * Suma por instante los libros que empiecen por el prefijo dado: "" para los
 * dos libros del oráculo, "bench_" para las dos líneas del índice. Puro.
 */
function combineCurve(
  rows: Array<{ at: number; equity: number; book: string }>,
  bench: boolean,
): Array<{ at: number; equity: number }> {
  const by = new Map<number, number>();
  for (const r of rows) {
    if (r.book.startsWith("bench_") !== bench) continue;
    by.set(r.at, (by.get(r.at) ?? 0) + r.equity);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([at, equity]) => ({ at, equity }));
}
