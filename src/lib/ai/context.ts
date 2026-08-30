import { desc } from "drizzle-orm";
import { db } from "@/db";
import { news, theses } from "@/db/schema";
import { computePortfolio, type PortfolioSummary } from "@/lib/portfolio";
import { fmtMoney, fmtPct, fmtQty } from "@/lib/utils";

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

/** Contexto extra: tesis guardadas y noticias recientes. */
export async function buildFullContext(): Promise<string> {
  const [p, thesisRows, newsRows] = await Promise.all([
    computePortfolio(),
    db.select().from(theses).limit(30),
    db.select().from(news).orderBy(desc(news.publishedAt)).limit(20),
  ]);

  const parts = ["## Estado de la cartera", portfolioToText(p)];

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
