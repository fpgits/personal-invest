import { generateObject } from "ai";
import { and, desc, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { news, type Asset, type NewsRow } from "@/db/schema";
import { analysisModel, fastModel } from "./ai/client";
import { NEWS_SYSTEM } from "./ai/prompts";
import { listAssets } from "./assets";
import { finnhub, getNewsFor } from "./market";
import type { NewsItem } from "./market/types";
import { getSetting, setSetting } from "./settings";
import { id } from "./utils";

export const NEWS_LAST_ERROR_KEY = "news_last_error";

/**
 * Las noticias cripto llegan sin ticker. Se etiquetan por nombre completo
 * ("Ethereum") o por simbolo en mayusculas como palabra entera (ETH), con
 * minimo de 3 letras para no casar con cualquier cosa. Puro y testeable.
 */
/**
 * Nombres de monedas que son palabras corrientes: por nombre no cuentan
 * ("Optimism grows..." no habla de OP); solo por simbolo.
 */
const AMBIGUOUS_NAMES = new Set([
  "optimism", "render", "near", "flow", "sui", "gas", "one", "ton", "dash",
  "fetch", "request", "status", "internet computer", "the graph", "aave",
  "celo", "core", "beam", "pixels", "notcoin", "worldcoin", "mask network",
]);

export function tagCrypto(
  headline: string,
  tracked: Array<Pick<Asset, "symbol" | "name">>,
): string[] {
  const out: string[] = [];
  for (const a of tracked) {
    const symbol = a.symbol.toUpperCase();
    const name = a.name.trim();
    const byName =
      name.length >= 4 &&
      !AMBIGUOUS_NAMES.has(name.toLowerCase()) &&
      new RegExp(`(^|[^A-Za-z])${escapeRe(name)}([^A-Za-z]|$)`, "i").test(headline);
    const bySymbol =
      symbol.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${escapeRe(symbol)}([^A-Za-z0-9]|$)`).test(headline);
    if (byName || bySymbol) out.push(symbol);
  }
  return [...new Set(out)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const analysisSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      summary: z.string(),
      sentiment: z.enum(["bullish", "bearish", "neutral"]),
      impact: z.enum(["high", "medium", "low"]),
    }),
  ),
});

/** Trae noticias de tus activos y las guarda sin procesar. */
export async function ingestNews(): Promise<number> {
  const assets = await listAssets();
  if (assets.length === 0) return 0;

  const items: NewsItem[] = await getNewsFor(assets);

  // Cripto: la categoria general de Finnhub, etiquetada por nombre/simbolo.
  // Lo que no menciona ninguna de tus monedas no entra.
  const cryptos = assets.filter((a) => a.assetClass === "crypto");
  if (cryptos.length > 0) {
    const seen = new Set(items.map((n) => n.url));
    for (const n of await finnhub.cryptoNews()) {
      if (seen.has(n.url)) continue;
      const tickers = tagCrypto(n.headline, cryptos);
      if (tickers.length === 0) continue;
      items.push({ ...n, tickers });
    }
  }

  let inserted = 0;

  for (const n of items) {
    const res = await db
      .insert(news)
      .values({
        id: id(),
        headline: n.headline,
        url: n.url,
        source: n.source,
        imageUrl: n.imageUrl,
        publishedAt: n.publishedAt,
        tickers: JSON.stringify(n.tickers),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ id: news.id });
    if (res.length > 0) inserted++;
  }

  return inserted;
}

/**
 * Resume y clasifica en lotes. Una sola llamada por lote en vez de una por
 * noticia: con 30 titulares eso es la diferencia entre 30 requests y 2.
 */
export async function processNews(limit = 30): Promise<number> {
  const pending = await db
    .select()
    .from(news)
    .where(or(isNull(news.processedAt), isNull(news.summary)))
    .orderBy(desc(news.publishedAt))
    .limit(limit);

  if (pending.length === 0) return 0;

  const BATCH = 10;
  let processed = 0;

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const prompt = batch
      .map(
        (n, idx) =>
          `${idx}. ${n.headline}${
            n.tickers !== "[]" ? ` (tickers: ${JSON.parse(n.tickers).join(", ")})` : ""
          }`,
      )
      .join("\n");

    try {
      const { object } = await summarizeBatch(prompt);

      for (const item of object.items) {
        const row = batch[item.index];
        if (!row) continue;
        await db
          .update(news)
          .set({
            summary: item.summary,
            sentiment: item.sentiment,
            impact: item.impact,
            processedAt: Date.now(),
          })
          .where(inArray(news.id, [row.id]));
        processed++;
      }
    } catch (e) {
      // Si los dos modelos fallan marcamos el lote como visto para no
      // reintentar en bucle en cada cron. El titular sigue siendo util sin
      // resumen. El motivo queda en los logs y en Ajustes/Noticias: un modelo
      // mal configurado se ve, no se esconde tras un 200 vacio.
      const message = e instanceof Error ? e.message : String(e);
      console.error("[news] resumen fallo:", message);
      await setSetting(NEWS_LAST_ERROR_KEY, JSON.stringify({ at: Date.now(), message })).catch(
        () => undefined,
      );
      for (const row of batch) {
        await db
          .update(news)
          .set({ processedAt: Date.now() })
          .where(inArray(news.id, [row.id]));
      }
    }
  }

  if (processed > 0) {
    await setSetting(NEWS_LAST_ERROR_KEY, "").catch(() => undefined);
  }
  return processed;
}

/**
 * Resume con el modelo rapido y, si este falla (modelo mal configurado,
 * sin salida estructurada, cuota), reintenta una vez con el de analisis:
 * son 10 titulares, cuesta centimos, y deja el motor de eventos alimentado.
 */
async function summarizeBatch(prompt: string) {
  const run = async (model: Awaited<ReturnType<typeof fastModel>>) =>
    generateObject({
      model,
      schema: analysisSchema,
      system: NEWS_SYSTEM,
      prompt: `Analiza estos titulares y devuelve un objeto por cada uno, usando el mismo index:\n\n${prompt}`,
      temperature: 0.2,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(45_000),
    });
  try {
    return await run(await fastModel());
  } catch (e) {
    console.warn(
      "[news] modelo rapido fallo, probando con el de analisis:",
      e instanceof Error ? e.message : String(e),
    );
    return run(await analysisModel());
  }
}

export async function newsLastError(): Promise<{ at: number; message: string } | null> {
  const raw = await getSetting(NEWS_LAST_ERROR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; message: string };
  } catch {
    return null;
  }
}

export async function recentNews(
  limit = 50,
  window: { fromMs?: number; toMs?: number } = {},
): Promise<NewsRow[]> {
  const conds = [];
  if (window.fromMs !== undefined) conds.push(gte(news.publishedAt, window.fromMs));
  if (window.toMs !== undefined) conds.push(lte(news.publishedAt, window.toMs));
  return db
    .select()
    .from(news)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(news.publishedAt))
    .limit(limit);
}
