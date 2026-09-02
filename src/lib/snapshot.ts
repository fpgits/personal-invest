import { and, asc, desc, gte, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { snapshots, type Snapshot } from "@/db/schema";
import { computePortfolio, type PortfolioSummary } from "./portfolio";
import { id, today } from "./utils";

/**
 * Una foto vale si las posiciones que importan tienen precio. Si el proveedor
 * de precios fallo, guardar la foto contamina el historico (la del 31 de
 * agosto de 2026 salio con 18 acciones a 0); mejor no guardar y que el cron
 * reintente o que la reconstruccion la rellene con cierres de verdad.
 */
export function isReliableSummary(p: PortfolioSummary): boolean {
  if (p.positions.length === 0) return false;
  for (const x of p.positions) {
    if (x.asset.assetClass === "cash") continue;
    if (x.quantity > 0 && x.price <= 0 && x.costBasis > 100) return false;
  }
  return true;
}

export type SnapshotResult = { snapshot: Snapshot; stored: boolean; reason?: string };

/**
 * Guarda la foto del dia (precios en vivo). El grafico y el resultado por
 * periodo salen de aqui. `force` guarda aunque falten precios.
 */
export async function takeSnapshot(opts: { force?: boolean } = {}): Promise<SnapshotResult> {
  const p = await computePortfolio();
  const date = today();

  const row = {
    id: id(),
    date,
    totalValue: p.totalValue,
    costBasis: p.costBasis,
    unrealizedPnl: p.unrealizedPnl,
    realizedPnl: p.realizedPnl,
    breakdown: JSON.stringify({
      byClass: p.byClass,
      positions: p.positions.map((x) => ({
        assetId: x.asset.id,
        symbol: x.asset.symbol,
        assetClass: x.asset.assetClass,
        group: x.group,
        value: x.value,
        quantity: x.quantity,
        price: x.price,
        weight: x.weight,
        unrealizedPnl: x.unrealizedPnl,
        realizedPnl: x.realizedPnl,
      })),
    }),
    source: "live",
    createdAt: Date.now(),
  };

  if (!opts.force && !isReliableSummary(p)) {
    const missing = p.positions
      .filter((x) => x.asset.assetClass !== "cash" && x.quantity > 0 && x.price <= 0)
      .map((x) => x.asset.symbol);
    return {
      snapshot: row as Snapshot,
      stored: false,
      reason:
        p.positions.length === 0
          ? "cartera vacia"
          : `sin precio: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`,
    };
  }

  await db
    .insert(snapshots)
    .values(row)
    .onConflictDoUpdate({
      target: snapshots.date,
      set: {
        totalValue: row.totalValue,
        costBasis: row.costBasis,
        unrealizedPnl: row.unrealizedPnl,
        realizedPnl: row.realizedPnl,
        breakdown: row.breakdown,
        source: "live",
      },
    });

  return { snapshot: row as Snapshot, stored: true };
}

export async function history(days = 365): Promise<Snapshot[]> {
  const rows = await db
    .select()
    .from(snapshots)
    .orderBy(desc(snapshots.date))
    .limit(days);
  return rows.reverse();
}

/**
 * Snapshots que necesita un periodo: los ultimos ANTERIORES a `from` (el
 * cierre del dia previo es el punto de partida; se traen varios por si los
 * mas recientes no son fiables) y todos hasta `to`.
 */
export async function snapshotsAround(from: string, to: string): Promise<Snapshot[]> {
  const before = await db
    .select()
    .from(snapshots)
    .where(lt(snapshots.date, from))
    .orderBy(desc(snapshots.date))
    .limit(10);
  const inside = await db
    .select()
    .from(snapshots)
    .where(and(gte(snapshots.date, from), lte(snapshots.date, to)))
    .orderBy(asc(snapshots.date));
  return [...before, ...inside];
}

export async function firstSnapshot(): Promise<Snapshot | null> {
  const rows = await db
    .select()
    .from(snapshots)
    .orderBy(asc(snapshots.date))
    .limit(1);
  return rows[0] ?? null;
}
