import { asc, desc } from "drizzle-orm";
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
        symbol: x.asset.symbol,
        value: x.value,
        quantity: x.quantity,
        price: x.price,
        weight: x.weight,
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

export async function firstSnapshot(): Promise<Snapshot | null> {
  const rows = await db
    .select()
    .from(snapshots)
    .orderBy(asc(snapshots.date))
    .limit(1);
  return rows[0] ?? null;
}
