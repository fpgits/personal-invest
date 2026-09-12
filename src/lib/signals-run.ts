import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, insiderTransactions, theses, thesisAssumptions } from "@/db/schema";
import { insiderSignals } from "./insiders";
import { listManagers } from "./managers";
import type { AssumptionLite, EventLite, InsiderLite, ManagerLite, SignalInput } from "./conviction-signals";

/**
 * Recoge, para cada activo, todo lo que la plataforma sabe de el ademas de sus
 * fundamentales: compras de directivos, movimientos de los gestores que sigues,
 * hechos recientes y el estado de tu tesis.
 *
 * El calculo de cuanto pesa cada cosa vive en conviction-signals.ts y es puro.
 * Aqui solo se lee la base. Todo es mejor esfuerzo: si una fuente falla, el
 * veredicto sale sin ella en vez de no salir.
 */

/** Ventana de las senales que modifican el veredicto. */
export const SIGNAL_WINDOW_DAYS = 30;

export type SignalsBySymbol = Record<string, SignalInput>;

/** Compras y ventas de directivos de los ultimos 30 dias, por simbolo. */
async function insidersFor(symbols: string[], now: number): Promise<Record<string, InsiderLite[]>> {
  const since = now - SIGNAL_WINDOW_DAYS * 86400_000;
  const rows = await db
    .select()
    .from(insiderTransactions)
    .where(and(inArray(insiderTransactions.symbol, symbols), gte(insiderTransactions.transactionAt, since)))
    .catch(() => []);

  const bySymbol = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const list = bySymbol.get(key) ?? [];
    list.push(r);
    bySymbol.set(key, list);
  }

  const out: Record<string, InsiderLite[]> = {};
  for (const [symbol, txs] of bySymbol) {
    // insiderSignals solo emite lo que se apoya en un filing "nuevo" para no
    // repetir eventos. Aqui NO queremos eso: para el veredicto cuenta todo lo
    // que hay en la ventana, se haya avisado antes o no.
    const all = new Set(txs.map((t) => t.accession));
    const signals = insiderSignals(txs, all, now, SIGNAL_WINDOW_DAYS);
    if (signals.length > 0) {
      out[symbol] = signals.map((s) => ({
        kind: s.kind,
        totalValue: s.totalValue,
        owners: s.owners,
        occurredAt: s.occurredAt,
      }));
    }
  }
  return out;
}

/**
 * Ultimo movimiento de cada gestor seguido, por ticker. Reutiliza la misma
 * lectura que pinta la pagina de Inversores: si ahi se ve un cambio, aqui
 * pesa, y no hay dos versiones del mismo diff.
 */
async function managersFor(symbols: string[]): Promise<Record<string, ManagerLite[]>> {
  const wanted = new Set(symbols);
  const out: Record<string, ManagerLite[]> = {};

  const views = await listManagers().catch(() => []);
  for (const v of views) {
    if (!v.manager.enabled || !v.latest) continue;
    for (const c of v.latest.changes) {
      const ticker = (c.ticker ?? "").toUpperCase();
      if (!ticker || !wanted.has(ticker)) continue;
      (out[ticker] ??= []).push({
        kind: c.kind,
        manager: v.manager.name,
        pct: c.pct,
        deltaPct: c.deltaPct,
      });
    }
  }
  return out;
}

/** Hechos con impacto sobre la tesis en los ultimos 30 dias, por activo. */
async function eventsFor(assetIds: Map<string, string>, now: number): Promise<Record<string, EventLite[]>> {
  const since = now - SIGNAL_WINDOW_DAYS * 86400_000;
  const ids = [...assetIds.values()];
  if (ids.length === 0) return {};
  const rows = await db
    .select()
    .from(events)
    .where(and(inArray(events.primaryAssetId, ids), gte(events.occurredAt, since)))
    .orderBy(desc(events.occurredAt))
    .catch(() => []);

  const symbolOf = new Map([...assetIds].map(([symbol, id]) => [id, symbol]));
  const out: Record<string, EventLite[]> = {};
  for (const e of rows) {
    const symbol = e.primaryAssetId ? symbolOf.get(e.primaryAssetId) : undefined;
    if (!symbol) continue;
    (out[symbol] ??= []).push({
      priority: e.priority,
      thesisImpact: e.thesisImpact,
      headline: e.headline,
      occurredAt: e.occurredAt,
    });
  }
  return out;
}

/** Estado de los supuestos de tu tesis, por activo. */
async function thesisFor(assetIds: Map<string, string>): Promise<Record<string, AssumptionLite[]>> {
  const ids = [...assetIds.values()];
  if (ids.length === 0) return {};
  const rows = await db
    .select({ assetId: theses.assetId, statement: thesisAssumptions.statement, status: thesisAssumptions.status })
    .from(thesisAssumptions)
    .innerJoin(theses, eq(thesisAssumptions.thesisId, theses.id))
    .where(inArray(theses.assetId, ids))
    .catch(() => []);

  const symbolOf = new Map([...assetIds].map(([symbol, id]) => [id, symbol]));
  const out: Record<string, AssumptionLite[]> = {};
  for (const r of rows) {
    const symbol = symbolOf.get(r.assetId);
    if (!symbol) continue;
    (out[symbol] ??= []).push({ statement: r.statement, status: r.status });
  }
  return out;
}

/**
 * Todo junto, listo para pasarselo a evaluate(). Las cuatro consultas van en
 * paralelo y cada una se cae sola: un veredicto sin insiders es peor que uno
 * con ellos, pero mucho mejor que ninguno.
 */
export async function collectSignalsFor(
  assets: Array<{ symbol: string; assetId: string }>,
  now = Date.now(),
): Promise<SignalsBySymbol> {
  const symbols = assets.map((a) => a.symbol.toUpperCase());
  const assetIds = new Map(assets.map((a) => [a.symbol.toUpperCase(), a.assetId]));
  if (symbols.length === 0) return {};

  const [ins, mgr, evs, thx] = await Promise.all([
    insidersFor(symbols, now).catch(() => ({}) as Record<string, InsiderLite[]>),
    managersFor(symbols).catch(() => ({}) as Record<string, ManagerLite[]>),
    eventsFor(assetIds, now).catch(() => ({}) as Record<string, EventLite[]>),
    thesisFor(assetIds).catch(() => ({}) as Record<string, AssumptionLite[]>),
  ]);

  const out: SignalsBySymbol = {};
  for (const symbol of symbols) {
    const input: SignalInput = {
      insiders: ins[symbol],
      managers: mgr[symbol],
      events: evs[symbol],
      assumptions: thx[symbol],
    };
    if (input.insiders || input.managers || input.events || input.assumptions) out[symbol] = input;
  }
  return out;
}
