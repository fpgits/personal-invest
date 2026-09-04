import type { MacroSnapshot } from "@/lib/macro";
import { fmtDay } from "@/lib/period";

/**
 * Tira macro compacta (FRED): tipos, curva, inflacion y desempleo. Contexto,
 * no cartera. Si no hay clave FRED, `available` es false y no se muestra nada.
 */
export function MacroStrip({ macro }: { macro: MacroSnapshot }) {
  if (!macro.available) return null;

  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);
  const spread = macro.spread10y2y;

  const cells: Array<{ label: string; value: string; tone?: "up" | "down" }> = [
    { label: "Treasury 10A", value: pct(macro.tenY) },
    { label: "Treasury 2A", value: pct(macro.twoY) },
    {
      label: "Curva 10-2",
      value:
        spread === null
          ? "—"
          : `${spread > 0 ? "+" : ""}${spread.toFixed(2)} pp${spread < 0 ? " ·inv" : ""}`,
      tone: spread === null ? undefined : spread < 0 ? "down" : "up",
    },
    { label: "Fed funds", value: pct(macro.fedFunds) },
    { label: "Inflacion IPC", value: pct(macro.inflationYoY) },
    { label: "Desempleo", value: pct(macro.unemployment) },
  ];

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Contexto macro</span>
        <span className="text-xs text-faint">
          FRED{macro.asOf ? ` · ${fmtDay(macro.asOf, false)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label}>
            <p className="text-xs text-faint">{c.label}</p>
            <p
              className={`tnum text-sm font-semibold ${
                c.tone === "down" ? "text-down" : c.tone === "up" ? "text-up" : ""
              }`}
            >
              {c.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
