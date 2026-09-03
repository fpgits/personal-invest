import { and, desc, gt, gte, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { news, type Asset, type NewsRow } from "@/db/schema";
import { aiObject } from "./ai/client";
import { classifyError, messageOf, type FailureKind } from "./ai/errors";
import { NEWS_SYSTEM } from "./ai/prompts";
import { listAssets } from "./assets";
import { finnhub, getNewsFor } from "./market";
import type { NewsItem } from "./market/types";
import { getSetting, setSetting } from "./settings";
import { id } from "./utils";

export const NEWS_LAST_ERROR_KEY = "news_last_error";

/**
 * Reintentos del resumen. Una noticia cuyo resumen fallo se vuelve a
 * intentar como mucho una vez al dia y solo mientras es reciente: el motor
 * de eventos descarta lo de mas de 14 dias, asi que resumir algo de hace
 * dos semanas es tirar el dinero. Antes se reenviaban TODAS las fallidas
 * en cada pasada (cada 4 h), con dos modelos cada vez.
 */
export const NEWS_RETRY = {
  /** Espera minima entre intentos de una misma noticia. */
  cooldownMs: 24 * 3600_000,
  /** Noticias publicadas hace mas de esto ya no se reintentan. */
  maxAgeMs: 7 * 86400_000,
  /** Titulares por llamada al modelo. */
  batch: 10,
} as const;

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
 * Que noticias entran en esta pasada: primero las nunca procesadas (las mas
 * recientes antes) y, si queda hueco, las que fallaron hace mas de un dia y
 * siguen siendo recientes. Separado para poder testearlo contra una base local.
 */
export async function selectPendingNews(limit: number, now = Date.now()): Promise<NewsRow[]> {
  const fresh = await db
    .select()
    .from(news)
    .where(isNull(news.processedAt))
    .orderBy(desc(news.publishedAt))
    .limit(limit);
  if (fresh.length >= limit) return fresh;

  const retries = await db
    .select()
    .from(news)
    .where(
      and(
        isNotNull(news.processedAt),
        isNull(news.summary),
        lt(news.processedAt, now - NEWS_RETRY.cooldownMs),
        gt(news.publishedAt, now - NEWS_RETRY.maxAgeMs),
      ),
    )
    .orderBy(desc(news.publishedAt))
    .limit(limit - fresh.length);
  return [...fresh, ...retries];
}

/**
 * Resume y clasifica en lotes. Una sola llamada por lote en vez de una por
 * noticia: con 30 titulares eso es la diferencia entre 30 requests y 3.
 *
 * Fallos: un rechazo del proveedor o una salida invalida se reintenta una
 * vez con el modelo de analisis; si tampoco, el lote se marca como visto y
 * volvera a intentarse pasado un dia (`NEWS_RETRY`). Un fallo transitorio
 * (red, cuota, 5xx, timeout) o el presupuesto agotado paran la pasada sin
 * marcar nada: se retoma en el siguiente cron tal cual.
 */
export async function processNews(limit = 30): Promise<number> {
  const pending = await selectPendingNews(limit);
  if (pending.length === 0) return 0;

  let processed = 0;

  for (let i = 0; i < pending.length; i += NEWS_RETRY.batch) {
    const batch = pending.slice(i, i + NEWS_RETRY.batch);
    const prompt = batch
      .map(
        (n, idx) =>
          `${idx}. ${n.headline}${
            n.tickers !== "[]" ? ` (tickers: ${JSON.parse(n.tickers).join(", ")})` : ""
          }`,
      )
      .join("\n");

    const res = await summarizeBatch(prompt);

    if (res.ok) {
      for (const item of res.object.items) {
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
      continue;
    }

    // El motivo queda en los logs y en Ajustes/Noticias: un modelo mal
    // configurado se ve, no se esconde tras un 200 vacio.
    console.error(`[news] resumen fallo (${res.kind}):`, res.message);
    await setSetting(NEWS_LAST_ERROR_KEY, JSON.stringify({ at: Date.now(), message: res.message })).catch(
      () => undefined,
    );
    if (res.kind === "transient" || res.kind === "budget") break;
    await db
      .update(news)
      .set({ processedAt: Date.now() })
      .where(inArray(news.id, batch.map((row) => row.id)));
  }

  if (processed > 0) {
    await setSetting(NEWS_LAST_ERROR_KEY, "").catch(() => undefined);
  }
  return processed;
}

type BatchResult =
  | { ok: true; object: z.infer<typeof analysisSchema> }
  | { ok: false; kind: FailureKind; message: string };

/**
 * Resume con el modelo rapido. Si este RECHAZA la peticion o devuelve algo
 * invalido (modelo mal configurado, sin salida estructurada), reintenta una
 * vez con el de analisis: son 10 titulares y deja el motor de eventos
 * alimentado. Un fallo transitorio no se reintenta con el modelo caro: si
 * OpenRouter esta caido o sin cuota, el otro modelo fallara igual y costaria
 * el doble de intentos.
 */
async function summarizeBatch(prompt: string): Promise<BatchResult> {
  const run = async (tier: "fast" | "analysis") =>
    aiObject("news_summary", {
      schema: analysisSchema,
      system: NEWS_SYSTEM,
      prompt: `Analiza estos titulares y devuelve un objeto por cada uno, usando el mismo index:\n\n${prompt}`,
      temperature: 0.2,
      tier,
    });
  try {
    return { ok: true, object: (await run("fast")).object };
  } catch (e) {
    const kind = classifyError(e);
    if (kind === "transient" || kind === "budget") return { ok: false, kind, message: messageOf(e) };
    console.warn("[news] modelo rapido fallo, probando con el de analisis:", messageOf(e));
    try {
      return { ok: true, object: (await run("analysis")).object };
    } catch (e2) {
      return { ok: false, kind: classifyError(e2), message: messageOf(e2) };
    }
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
