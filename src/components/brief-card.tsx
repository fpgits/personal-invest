"use client";

import useSWR from "swr";
import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui";
import type { Brief, BriefAction, BriefItem } from "@/lib/brief";
import { money } from "@/lib/brief-format";
import { api, cn, fmtDateTime } from "@/lib/utils";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

/** Verbo y color por accion. */
const ACTION: Record<BriefAction, { label: string; cls: string }> = {
  comprar: { label: "Compra", cls: "bg-up text-white" },
  vender: { label: "Vende", cls: "bg-down text-white" },
  reducir: { label: "Reduce", cls: "bg-warn text-white" },
  revisar: { label: "Revisa", cls: "bg-warn text-white" },
  buena_senal: { label: "A favor", cls: "bg-up text-white" },
  esperar: { label: "Espera", cls: "bg-surface-2 text-muted border border-border" },
  vigilar: { label: "Vigila", cls: "bg-surface-2 text-muted border border-border" },
};


function Item({ it }: { it: BriefItem }) {
  const a = ACTION[it.action];
  const body = (
    <div className="flex items-start gap-3">
      <span className={cn("mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold", a.cls)}>{a.label}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{it.title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-muted">{it.why}</p>
      </div>
      {it.href && <ArrowRight size={14} className="mt-1 shrink-0 text-faint" />}
    </div>
  );
  return it.href ? (
    <Link href={it.href} className="block rounded-lg px-2 py-2 transition hover:bg-surface-2">
      {body}
    </Link>
  ) : (
    <div className="px-2 py-2">{body}</div>
  );
}

/**
 * La tarjeta "Que hacer". `compact` para el Resumen (lo esencial y un enlace);
 * completa para su pagina.
 */
export function BriefCard({ compact = false }: { compact?: boolean }) {
  const { data, error, isLoading, mutate, isValidating } = useSWR<Brief>(api("/api/brief"), fetcher, {
    revalidateOnFocus: false,
  });

  if (isLoading) {
    return (
      <Card className={cn(compact && "mb-6")}>
        <p className="flex items-center gap-2 text-sm text-muted">
          <RefreshCw size={14} className="animate-spin text-faint" />
          Preparando tu resumen...
        </p>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className={cn(compact && "mb-6")}>
        <p className="text-sm text-down">{error ? (error as Error).message : "Sin datos"}</p>
      </Card>
    );
  }

  if (compact) {
    const top = data.week.items.slice(0, 3);
    return (
      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-faint">Que hacer</p>
            <p className="mt-1 text-base font-medium leading-snug">{data.summary}</p>
          </div>
          <Link
            href="/invest/brief"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Ver el plan
            <ArrowRight size={14} />
          </Link>
        </div>
        {top.length > 0 && (
          <div className="mt-3 divide-y divide-border border-t border-border">
            {top.map((it, i) => (
              <Item key={i} it={it} />
            ))}
          </div>
        )}
      </Card>
    );
  }

  const { month } = data;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-lg font-medium leading-snug">{data.summary}</p>
          <button
            onClick={() => mutate(fetcher(api("/api/brief?force=1")), { revalidate: false })}
            disabled={isValidating}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:text-text disabled:opacity-40"
          >
            <RefreshCw size={14} className={cn(isValidating && "animate-spin")} />
            Recalcular
          </button>
        </div>
        <p className="mt-2 text-xs text-faint">
          Calculado {fmtDateTime(data.generatedAt)} con tus numeros reales. Es apoyo a tu criterio, no una orden; la app no
          opera.
        </p>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Esta semana</h2>
        <p className="mt-1 text-sm text-muted">{data.week.headline}</p>
        {data.week.items.length > 0 && (
          <div className="mt-3 divide-y divide-border border-t border-border">
            {data.week.items.map((it, i) => (
              <Item key={i} it={it} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Este mes</h2>
        <p className="mt-1 text-sm text-muted">{month.headline}</p>

        {month.equity.lines.length > 0 && (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {month.equity.lines.map((l) => (
              <li key={l.symbol} className="flex items-start gap-3 px-2 py-2">
                <span className="mt-0.5 shrink-0 rounded-md bg-up px-2 py-0.5 text-xs font-semibold text-white">Compra</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {l.symbol} <span className="tnum">{money(l.amount, data.currency)}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-muted">{l.why}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {month.equity.reserve > 0 && (
          <p className="mt-3 text-sm">
            <span className="font-medium">
              Guarda {money(month.equity.reserve, data.currency)}
              {month.equity.reserveSymbol ? ` en ${month.equity.reserveSymbol}` : " en efectivo"}.
            </span>{" "}
            {month.equity.reserveWhy && <span className="text-muted">{month.equity.reserveWhy}</span>}
          </p>
        )}

        {month.crypto.cash > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-sm font-medium">Cripto: {money(month.crypto.cash, data.currency)}</p>
            {month.crypto.lines.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Define tu reparto cripto en Ajustes (p. ej. BTC:60,ETH:40).</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {month.crypto.lines.map((l) => (
                  <li key={l.symbol} className="text-sm">
                    <span className="font-medium">
                      {l.symbol} <span className="tnum">{money(l.amount, data.currency)}</span>
                    </span>{" "}
                    <span className="text-muted">— {l.why}</span>
                  </li>
                ))}
              </ul>
            )}
            {month.crypto.reserve > 0 && (
              <p className="mt-2 text-sm text-muted">
                Deja {money(month.crypto.reserve, data.currency)} en stablecoin para la proxima caida.
              </p>
            )}
            {month.crypto.extra > 0 && (
              <p className="mt-2 text-sm text-warn">
                El ciclo pediria {money(month.crypto.extra, data.currency)} mas de lo habitual: solo si tienes reserva.
              </p>
            )}
          </div>
        )}
        <p className="mt-4 text-xs text-faint">
          Para cambiar cuanto aportas o que tan exigente eres: Ajustes → Oraculo. Para el detalle y guardar la llamada del
          mes: <Link href="/invest/analisis" className="underline">Analisis → Veredicto</Link>.
        </p>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">Vigilar</h2>
        <p className="mt-1 text-sm text-muted">{data.watch.headline}</p>
        {data.watch.items.length > 0 && (
          <div className="mt-3 divide-y divide-border border-t border-border">
            {data.watch.items.map((it, i) => (
              <Item key={i} it={it} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
