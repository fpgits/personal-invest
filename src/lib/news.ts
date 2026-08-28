import { generateObject } from "ai";
import { desc, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { news, type NewsRow } from "@/db/schema";
import { fastModel } from "./ai/client";
import { NEWS_SYSTEM } from "./ai/prompts";
import { listAssets } from "./assets";
import { getNewsFor } from "./market";
import { id } from "./utils";

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

  const items = await getNewsFor(assets);
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
      const { object } = await generateObject({
        model: await fastModel(),
        schema: analysisSchema,
        system: NEWS_SYSTEM,
        prompt: `Analiza estos titulares y devuelve un objeto por cada uno, usando el mismo index:\n\n${prompt}`,
        temperature: 0.2,
      });

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
    } catch {
      // Si el modelo falla marcamos el lote como visto para no reintentar
      // en bucle en cada cron. El titular sigue siendo util sin resumen.
      for (const row of batch) {
        await db
          .update(news)
          .set({ processedAt: Date.now() })
          .where(inArray(news.id, [row.id]));
      }
    }
  }

  return processed;
}

export async function recentNews(limit = 50): Promise<NewsRow[]> {
  return db.select().from(news).orderBy(desc(news.publishedAt)).limit(limit);
}
