"use client";

import useSWR from "swr";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge, Card, CardTitle } from "@/components/ui";
import type { ConvictionCall } from "@/db/schema";
import { POSTURE_LABEL, type Posture } from "@/lib/conviction-labels";
import type { PostureStats } from "@/lib/conviction-calls";
import { api, cn, fmtDate } from "@/lib/utils";

type History = { calls: ConvictionCall[]; stats: PostureStats[]; asOf: number };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const HORIZONS = [30, 90, 180, 365] as const;

function label(p: PostureStats["posture"]): string {
  return p === "benchmark" ? "Indice (VOO)" : POSTURE_LABEL[p as Posture];
}

function Ret({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint">–</span>;
  return (
    <span className={cn("tnum", v > 0 && "text-up", v < 0 && "text-down")}>
      {v > 0 ? "+" : ""}
      {v}%
    </span>
  );
}

/**
 * Historial del oraculo: lo que dijo, cuando, y como le fue. La credibilidad
 * del sistema es esta tabla, no su elocuencia. Los retornos se rellenan solos
 * cuando vence cada plazo (job nocturno).
 */
export function HistoryCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, error, isLoading } = useSWR<History>(api(`/api/conviction/history?k=${refreshKey}`), fetcher, {
    revalidateOnFocus: false,
  });
  const [open, setOpen] = useState(false);

  const stats = (data?.stats ?? []).filter((s) => s.n > 0);
  const anyDue = stats.some((s) => HORIZONS.some((h) => s.counts[h] > 0));

  return (
    <Card>
      <CardTitle>Historial del oraculo</CardTitle>
      {isLoading && <p className="text-sm text-muted">Cargando...</p>}
      {error && <p className="text-sm text-down">{(error as Error).message}</p>}
      {data && data.calls.length === 0 && (
        <p className="text-sm text-muted">
          Todavia no hay llamadas registradas. Genera el plan del mes y guardalo: a partir de
          ahi cada llamada se mide a 30, 90, 180 y 365 dias.
        </p>
      )}

      {stats.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-faint">
                  <th className="py-1.5 pr-3 font-medium">Postura</th>
                  <th className="py-1.5 pr-3 font-medium tnum">N</th>
                  {HORIZONS.map((h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">
                      {h}d
                    </th>
                  ))}
                  <th className="py-1.5 font-medium">Acierto</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.posture} className="border-t border-border">
                    <td className="py-2 pr-3 font-medium">{label(s.posture)}</td>
                    <td className="py-2 pr-3 tnum text-muted">{s.n}</td>
                    {HORIZONS.map((h) => (
                      <td key={h} className="py-2 pr-3">
                        <Ret v={s.avg[h]} />
                        {s.counts[h] > 0 && <span className="ml-1 text-[10px] text-faint">({s.counts[h]})</span>}
                      </td>
                    ))}
                    <td className="py-2">
                      {s.hitRate[90] !== null ? (
                        <span className="tnum">{s.hitRate[90]}% a 90d</span>
                      ) : s.hitRate[30] !== null ? (
                        <span className="tnum">{s.hitRate[30]}% a 30d</span>
                      ) : (
                        <span className="text-faint">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!anyDue && (
            <p className="mt-2 text-xs text-faint">
              Aun no ha vencido ningun plazo: los retornos apareceran a los 30 dias de la primera llamada.
            </p>
          )}
          <p className="mt-2 text-xs text-faint">
            Retorno medio del precio desde la llamada. Acierto: en compras, que subiera; en recortes y ventas,
            que cayera. El indice es la referencia a batir en el mismo periodo.
          </p>
        </>
      )}

      {data && data.calls.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-faint transition hover:text-muted"
          >
            <ChevronDown size={12} className={cn("transition", open && "rotate-180")} />
            Llamadas recientes ({data.calls.length})
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {data.calls.slice(0, 60).map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
                  <span className="w-20 text-faint">{fmtDate(c.calledAt)}</span>
                  <span className="w-14 font-semibold">{c.symbol}</span>
                  <Badge tone={c.kind === "benchmark" ? "neutral" : c.posture === "buy" || c.posture === "strong_buy" ? "up" : c.posture === "hold" ? "accent" : c.posture === "reduce" ? "warn" : "down"}>
                    {c.kind === "benchmark" ? "Indice" : POSTURE_LABEL[c.posture as Posture]}
                  </Badge>
                  {c.planAmount !== null && c.planAmount > 0 && (
                    <span className="tnum text-muted">${Math.round(c.planAmount)}</span>
                  )}
                  <span className="ml-auto flex gap-3">
                    {HORIZONS.map((h) => {
                      const v = h === 30 ? c.ret30 : h === 90 ? c.ret90 : h === 180 ? c.ret180 : c.ret365;
                      return (
                        <span key={h} className="w-14 text-right">
                          <Ret v={v} />
                        </span>
                      );
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
