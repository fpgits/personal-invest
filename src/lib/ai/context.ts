import { desc } from "drizzle-orm";
import { db } from "@/db";
import { news, theses } from "@/db/schema";
import { POSTURE_LABEL } from "@/lib/conviction-labels";
import { cachedMonthlyPlan, type MonthlyPlan } from "@/lib/conviction-run";
import { getMacro, macroToText } from "@/lib/macro";
import { computePortfolio, type PortfolioSummary } from "@/lib/portfolio";
import { fmtMoney, fmtPct, fmtQty } from "@/lib/utils";
import { CHAT_LIMITS } from "./policy";

/**
 * Convierte la cartera en texto compacto para meter en el prompt.
 * Objetivo: que quepa sobrado en cualquier modelo y que no haya ambiguedad
 * sobre que numero es que.
 */
export function portfolioToText(p: PortfolioSummary): string {
  if (p.positions.length === 0) {
    return "La cartera esta vacia. No hay posiciones abiertas.";
  }

  const lines: string[] = [];
  lines.push(`Moneda base: ${p.currency}`);
  lines.push(`Valor total: ${fmtMoney(p.totalValue, p.currency)}`);
  lines.push(`Coste total: ${fmtMoney(p.costBasis, p.currency)}`);
  lines.push(
    `P&L no realizado: ${fmtMoney(p.unrealizedPnl, p.currency)} (${fmtPct(p.unrealizedPct)})`,
  );
  lines.push(`P&L realizado historico: ${fmtMoney(p.realizedPnl, p.currency)}`);
  lines.push(`Dividendos cobrados: ${fmtMoney(p.dividends, p.currency)}`);
  lines.push(
    `Variacion del dia: ${fmtMoney(p.dayChange, p.currency)} (${fmtPct(p.dayChangePct)})`,
  );

  lines.push("");
  lines.push("Reparto por clase de activo:");
  for (const c of p.byClass) {
    lines.push(
      `- ${c.assetClass}: ${fmtMoney(c.value, p.currency)} (${c.weight.toFixed(1)}% de la cartera)`,
    );
  }

  lines.push("");
  lines.push(
    "Posiciones abiertas (simbolo | nombre | cantidad | coste medio | precio | valor | peso | P&L no realizado):",
  );
  for (const pos of p.positions) {
    lines.push(
      [
        pos.asset.symbol,
        pos.asset.name,
        fmtQty(pos.quantity),
        fmtMoney(pos.avgCost, p.currency),
        fmtMoney(pos.price, p.currency),
        fmtMoney(pos.value, p.currency),
        `${pos.weight.toFixed(1)}%`,
        `${fmtMoney(pos.unrealizedPnl, p.currency)} (${fmtPct(pos.unrealizedPct)})`,
      ].join(" | "),
    );
  }

  if (p.closed.length > 0) {
    lines.push("");
    lines.push("Posiciones cerradas (simbolo | P&L realizado):");
    for (const pos of p.closed.slice(0, 15)) {
      lines.push(`${pos.asset.symbol} | ${fmtMoney(pos.realizedPnl, p.currency)}`);
    }
  }

  if (p.degraded) {
    lines.push("");
    lines.push(
      "AVISO: algunos precios no se pudieron refrescar y pueden estar desactualizados.",
    );
  }

  return lines.join("\n");
}

export async function buildPortfolioContext(): Promise<string> {
  const p = await computePortfolio();
  return portfolioToText(p);
}

/**
 * El oraculo en texto: veredicto por activo y plan del mes. Sin esto el chat
 * respondia "cuanto compro de NVDA" con la cartera y las noticias, es decir
 * improvisando, mientras la app ya tenia el numero calculado. Ahora contesta
 * con las cifras del motor determinista, que es lo unico que puede defender.
 */
export function oracleToText(plan: MonthlyPlan, currency: string): string {
  const lines: string[] = [];
  const { run, equity, crypto, settings } = plan;

  const rated = run.results.filter((r) => r.posture !== "no_coverage");
  if (rated.length > 0) {
    lines.push(
      "Veredicto por activo (simbolo | en cartera | postura | puntuacion/100 | valor razonable | margen de seguridad | potencial):",
    );
    for (const r of [...rated].sort((a, b) => b.score - a.score)) {
      lines.push(
        [
          r.symbol,
          r.held ? "si" : "candidata (watchlist)",
          POSTURE_LABEL[r.posture],
          String(Math.round(r.score)),
          r.fairValue !== null ? fmtMoney(r.fairValue, currency) : "n/d",
          r.marginOfSafetyPct !== null ? `${r.marginOfSafetyPct}%` : "n/d",
          r.upsidePct !== null ? `${r.upsidePct}%` : "n/d",
        ].join(" | "),
      );
    }
  }

  lines.push("");
  lines.push(
    `Plan del mes en bolsa (efectivo ${fmtMoney(equity.cash, currency)}, tope por posicion ${settings.maxWeightPct}%, ticket minimo ${fmtMoney(settings.minTicket, currency)}):`,
  );
  if (equity.lines.length === 0) {
    lines.push("- Sin compras: nada supera el umbral de convicción a precio razonable.");
  } else {
    for (const l of equity.lines) {
      lines.push(`- ${l.symbol}: ${fmtMoney(l.amount, currency)} (${l.reason})`);
    }
  }
  if (equity.reserve > 0) {
    lines.push(
      `- Reserva: ${fmtMoney(equity.reserve, currency)}${equity.reserveSymbol ? ` en ${equity.reserveSymbol}` : " en efectivo"}`,
    );
  }
  if (equity.trims.length > 0) {
    lines.push("");
    lines.push(
      `Ventas y recortes propuestos (${fmtMoney(equity.trimTotal, currency)} en total) — simbolo | vender | acciones | % de la posicion | queda | motivo:`,
    );
    for (const t of equity.trims) {
      lines.push(
        [
          t.symbol,
          fmtMoney(t.amount, currency),
          t.shares !== null ? `${t.shares} acc.` : "n/d",
          `${t.pctOfPosition}%`,
          `${fmtMoney(t.valueAfter, currency)} (${t.weightBefore}% -> ${t.weightAfter}% de la cartera)`,
          t.reason,
        ].join(" | "),
      );
    }
  }

  lines.push("");
  lines.push(`Plan del mes en cripto (efectivo ${fmtMoney(crypto.cash, currency)}, modelo de ciclo, no fundamental):`);
  for (const l of crypto.lines) {
    lines.push(`- ${l.symbol}: ${fmtMoney(l.amount, currency)} (${l.multiplier}x) — ${l.reason}`);
  }
  if (crypto.reserve > 0) lines.push(`- Reserva en stablecoin: ${fmtMoney(crypto.reserve, currency)}`);

  lines.push("");
  lines.push(
    "IMPORTANTE: estos importes son los que ya calculo el motor determinista de la app. Si te preguntan cuanto comprar de algo, usa ESTA cifra y explica de donde sale; no inventes una distinta.",
  );
  return lines.join("\n");
}

/**
 * El contexto del chat (cartera, tesis, noticias) se reconstruye como mucho
 * cada `CHAT_LIMITS.contextTtlMs` por instancia: entre dos mensajes seguidos
 * no cambia nada que importe y ahorra las consultas y el refresco de precios.
 * Ademas, un prompt identico entre mensajes es lo que permite a los
 * proveedores servirlo desde su cache.
 */
let contextMemo: { at: number; text: string } | null = null;

export async function cachedFullContext(ttlMs = CHAT_LIMITS.contextTtlMs): Promise<string> {
  if (contextMemo && Date.now() - contextMemo.at < ttlMs) return contextMemo.text;
  const text = await buildFullContext();
  contextMemo = { at: Date.now(), text };
  return text;
}

/** Contexto extra: veredicto y plan del oraculo, tesis y noticias recientes. */
export async function buildFullContext(): Promise<string> {
  const [p, plan, thesisRows, newsRows, macro] = await Promise.all([
    computePortfolio(),
    // Si el oraculo falla (una API caida), el chat sigue con lo demas: es
    // mejor responder con la cartera que devolver un error.
    cachedMonthlyPlan().catch(() => null),
    db.select().from(theses).limit(30),
    db.select().from(news).orderBy(desc(news.publishedAt)).limit(20),
    getMacro().catch(() => null),
  ]);

  const parts = ["## Estado de la cartera", portfolioToText(p)];

  if (plan) parts.push(`## Veredicto y plan del oraculo\n${oracleToText(plan, p.currency)}`);

  const macroLine = macro ? macroToText(macro) : "";
  if (macroLine) parts.push(`## Macro\n${macroLine}`);

  if (thesisRows.length > 0) {
    parts.push("## Tesis guardadas");
    for (const t of thesisRows) {
      parts.push(
        `- conviccion ${t.conviction ?? "?"}/5: ${t.thesis.slice(0, 400)}`,
      );
    }
  }

  if (newsRows.length > 0) {
    parts.push("## Noticias recientes");
    for (const n of newsRows) {
      const tickers = (JSON.parse(n.tickers) as string[]).join(", ");
      parts.push(
        `- [${new Date(n.publishedAt).toISOString().slice(0, 10)}] ${n.headline}${
          tickers ? ` (${tickers})` : ""
        }${n.sentiment ? ` [${n.sentiment}]` : ""}`,
      );
    }
  }

  return parts.join("\n\n");
}
