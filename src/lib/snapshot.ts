import { and, asc, desc, gte, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { snapshots, type Snapshot } from "@/db/schema";
import { computePortfolio } from "./portfolio";
import { id, today } from "./utils";

/**
 * Guarda la foto del dia. El grafico historico de la cartera sale de aqui:
 * no hay forma de reconstruirlo a posteriori sin precios historicos de todo.
 */
export async function takeSnapshot(): Promise<Snapshot> {
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
    createdAt: Date.now(),
  };

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
      },
    });

  return row as Snapshot;
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
