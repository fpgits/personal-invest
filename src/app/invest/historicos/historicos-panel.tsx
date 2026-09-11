"use client";

import { useState } from "react";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";
import { Badge, Card, CardTitle } from "@/components/ui";
import type { EpisodeRow, ScanResult } from "@/lib/historicos";
import { api, cn } from "@/lib/utils";

type Payload = { rows: EpisodeRow[]; asOf: number };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

function money(n: number | null): string {
  if (n === null) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(1)}B`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}mm`;
  if (abs >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${Math.round(n)}`;
}
function pct(n: number | null, digits = 0): string {
  if (n === null) return "–";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
function num(n: number | null, digits = 2): string {
  return n === null ? "–" : n.toFixed(digits);
}

/**
 * Memoria de patrones: cada gran subida o máximo histórico con lo que había
 * seis meses antes. Aquí NO se mira cómo acabó (eso ya se sabe): se mira
 * qué se podía ver ENTONCES, con los datos que entonces eran públicos.
 */
export function HistoricosPanel() {
  const { data, error, isLoading, mutate } = useSWR<Payload>(api("/api/historicos"), fetcher, {
    revalidateOnFocus: false,
  });
  const [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [failed, setFailed] = useState<ScanResult[]>([]);

  async function rescan() {
    setBusy(true);
    setScanError(null);
    setFailed([]);
    try {
      const res = await fetch(api("/api/historicos"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { error?: string; results?: ScanResult[] };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // Los fallos por símbolo no revientan la pasada, pero tienen que verse:
      // una tabla vacía sin explicación parece que no hubo nada que encontrar.
      setFailed((body.results ?? []).filter((r) => r.error));
      await mutate();
    } catch (e) {
      setScanError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.rows ?? [];
  // Se reparte por la CLASE del activo, no por si hay foto. Antes se miraba
  // cycleDrawdownPct !== null y los primeros episodios de cada cripto (los que
  // no tienen seis meses de precio antes, asi que se quedan sin foto) caian en
  // la tabla de Bolsa: BNB y ETH de 2017 aparecian como acciones.
  const equities = rows.filter((r) => r.assetClass !== "crypto");
  const cryptos = rows.filter((r) => r.assetClass === "crypto");
  const cryptoNoSnapshot = cryptos.filter((r) => r.cycleDrawdownPct === null).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle
          action={
            <button
              onClick={rescan}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-text disabled:opacity-40"
            >
              <RefreshCw size={12} className={cn(busy && "animate-spin")} />
              {busy ? "Recorriendo el pasado…" : "Recalcular"}
            </button>
          }
        >
          Qué había antes de cada salto
        </CardTitle>
        <p className="text-sm text-muted">
          Cada fila es una subida de más del 80% en menos de un año, o la ruptura de un máximo de hace más
          de un año. Los números son los de <b>seis meses antes</b>, con lo que entonces era público: un
          10-K de febrero no cuenta para una foto de diciembre. La pregunta no es cómo acabó, sino qué se
          podía ver.
        </p>
        {isLoading && <p className="mt-3 text-sm text-muted">Cargando…</p>}
        {error && <p className="mt-3 text-sm text-down">{(error as Error).message}</p>}
        {scanError && <p className="mt-3 text-sm text-down">{scanError}</p>}
        {failed.length > 0 && (
          <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <p className="text-xs font-medium text-warn">
              {failed.length} {failed.length === 1 ? "activo se quedó" : "activos se quedaron"} sin recorrer
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-faint">
              {failed.slice(0, 8).map((f) => (
                <li key={f.symbol}>
                  <b className="text-muted">{f.symbol}</b> · {f.error}
                </li>
              ))}
              {failed.length > 8 && <li>y {failed.length - 8} más</li>}
            </ul>
          </div>
        )}
        {data && rows.length === 0 && (
          <p className="mt-3 text-sm text-faint">
            Todavía no hay episodios. Pulsa Recalcular: recorre los activos seguidos (tarda unos minutos:
            EDGAR y Stooq piden calma).
          </p>
        )}
      </Card>

      {equities.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5 pb-3">
            <CardTitle>Bolsa · {equities.length}</CardTitle>
            <p className="text-xs text-faint">
              Precio/ventas, EV/ventas y capitalización a la fecha de la foto; caída desde el máximo de
              los 5 años anteriores; señales de apuro y de catalizador en los filings de entonces.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-t border-b border-border text-left text-xs text-faint">
                  <th className="px-5 py-2 font-medium">Activo</th>
                  <th className="px-3 py-2 font-medium">Qué pasó</th>
                  <th className="px-3 py-2 text-right font-medium">Subida</th>
                  <th className="px-3 py-2 text-right font-medium">Días</th>
                  <th className="px-3 py-2 text-right font-medium">P/V antes</th>
                  <th className="px-3 py-2 text-right font-medium">EV/V</th>
                  <th className="px-3 py-2 text-right font-medium">Cap.</th>
                  <th className="px-3 py-2 text-right font-medium">Desde máx.</th>
                  <th className="px-3 py-2 text-right font-medium">Ventas</th>
                  <th className="px-3 py-2 text-right font-medium">Margen</th>
                  <th className="px-5 py-2 font-medium">Filings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {equities.map((r) => (
                  <tr key={`${r.symbol}-${r.kind}-${r.anchorDate}`} className="transition hover:bg-surface-2">
                    <td className="px-5 py-2 font-semibold">{r.symbol}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {r.kind === "ath" ? "Rompe máximo" : "Gran subida"} · {r.anchorDate}
                    </td>
                    <td className="tnum px-3 py-2 text-right text-up">{pct(r.gainPct)}</td>
                    <td className="tnum px-3 py-2 text-right text-muted">{r.days}</td>
                    <td className="tnum px-3 py-2 text-right">{num(r.ps)}</td>
                    <td className="tnum px-3 py-2 text-right">{num(r.evToSales)}</td>
                    <td className="tnum px-3 py-2 text-right">{money(r.marketCap)}</td>
                    <td className={cn("tnum px-3 py-2 text-right", r.drawdownPct !== null && r.drawdownPct < -60 && "text-down")}>
                      {pct(r.drawdownPct)}
                    </td>
                    <td className="tnum px-3 py-2 text-right">{pct(r.revenueGrowthPct)}</td>
                    <td className="tnum px-3 py-2 text-right">{pct(r.netMarginPct, 1)}</td>
                    <td className="px-5 py-2">
                      <span className="flex gap-1">
                        {r.distress && <Badge tone="warn">apuro</Badge>}
                        {r.catalyst && <Badge tone="up">catalizador</Badge>}
                        {!r.distress && !r.catalyst && <span className="text-xs text-faint">–</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {cryptos.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5 pb-3">
            <CardTitle>Cripto · {cryptos.length}</CardTitle>
            <p className="text-xs text-faint">
              Sin estados financieros: lo que había seis meses antes es el estado de ciclo, que es lo que usa
              la escalera. Aquí se ve si los saltos vinieron tras caídas profundas y mínimos que ya habían
              parado.
            </p>
            {cryptoNoSnapshot > 0 && (
              <p className="mt-1 text-xs text-faint">
                {cryptoNoSnapshot} sin foto: son los primeros episodios de cada moneda, cuando todavía no
                había seis meses de precio antes. Cuentan como episodio, pero no enseñan nada.
              </p>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-t border-b border-border text-left text-xs text-faint">
                  <th className="px-5 py-2 font-medium">Activo</th>
                  <th className="px-3 py-2 font-medium">Qué pasó</th>
                  <th className="px-3 py-2 text-right font-medium">Subida</th>
                  <th className="px-3 py-2 text-right font-medium">Días</th>
                  <th className="px-3 py-2 text-right font-medium">Caída desde máx. (6m antes)</th>
                  <th className="px-5 py-2 text-right font-medium">Días sin mínimo nuevo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cryptos.map((r) => (
                  <tr key={`${r.symbol}-${r.kind}-${r.anchorDate}`} className="transition hover:bg-surface-2">
                    <td className="px-5 py-2 font-semibold">{r.symbol}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {r.kind === "ath" ? "Rompe máximo" : "Gran subida"} · {r.anchorDate}
                    </td>
                    <td className="tnum px-3 py-2 text-right text-up">{pct(r.gainPct)}</td>
                    <td className="tnum px-3 py-2 text-right text-muted">{r.days}</td>
                    <td className="tnum px-3 py-2 text-right">{pct(r.cycleDrawdownPct)}</td>
                    <td className="tnum px-5 py-2 text-right">{r.daysSinceNewLow ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
