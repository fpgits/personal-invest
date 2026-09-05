import { XMLParser } from "fast-xml-parser";
import type { Asset } from "@/db/schema";
import { batched } from "@/lib/utils";
import type { NewsItem } from "./types";

/**
 * Google News (RSS, sin clave) como segundo agregador. Cubre mejor las
 * empresas chicas que Finnhub trae poco. Cada item viene con el nombre del
 * medio original (`source`), que es lo que usa el clasificador de tiers: el
 * enlace es un redirector de Google, asi que el host no sirve para eso.
 */

export const GOOGLE_NEWS_LIMITS = {
  /** Items por simbolo y pasada. */
  perSymbol: 10,
  /** Solo lo publicado en estos dias. */
  maxAgeDays: 5,
  /** Simbolos por pasada (2 pasadas al dia). */
  maxSymbols: 40,
  pauseMs: 400,
} as const;

const RSS_URL = (query: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: true });

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  source?: string | { "#text"?: string; "@_url"?: string };
};

/** Parsea el RSS de Google News a NewsItem, etiquetado con el simbolo. Puro. */
export function parseGoogleNewsRss(xml: string, symbol: string, now = Date.now()): NewsItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const rss = (doc.rss ?? {}) as Record<string, unknown>;
  const channel = (rss.channel ?? {}) as Record<string, unknown>;
  const raw = channel.item;
  const items: RssItem[] = raw === undefined ? [] : Array.isArray(raw) ? (raw as RssItem[]) : [raw as RssItem];
  const since = now - GOOGLE_NEWS_LIMITS.maxAgeDays * 86400_000;
  const out: NewsItem[] = [];
  for (const it of items) {
    const link = (it.link ?? "").trim();
    let title = (it.title ?? "").trim();
    if (!link || !title) continue;
    const publishedAt = Date.parse(it.pubDate ?? "");
    if (!Number.isFinite(publishedAt) || publishedAt < since) continue;
    const sourceName = typeof it.source === "string" ? it.source : (it.source?.["#text"] ?? "");
    // Google pone " - Medio" al final del titular; lo quitamos, el medio va aparte.
    if (sourceName && title.endsWith(` - ${sourceName}`)) title = title.slice(0, -(sourceName.length + 3)).trim();
    out.push({
      headline: title,
      url: link,
      source: sourceName || null,
      imageUrl: null,
      publishedAt,
      tickers: [symbol.toUpperCase()],
    });
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, GOOGLE_NEWS_LIMITS.perSymbol);
}

/** Consulta: el simbolo mas la palabra stock evita homonimos ("META" solo, no). */
export function googleNewsQuery(a: Pick<Asset, "symbol" | "name">): string {
  const name = a.name && a.name.toUpperCase() !== a.symbol.toUpperCase() ? ` OR "${a.name}"` : "";
  return `${a.symbol} stock${name}`;
}

export async function googleNewsFor(assets: Array<Pick<Asset, "symbol" | "name" | "assetClass">>): Promise<NewsItem[]> {
  const equities = assets.filter((a) => a.assetClass !== "crypto" && a.assetClass !== "cash").slice(0, GOOGLE_NEWS_LIMITS.maxSymbols);
  const lists = await batched(
    equities,
    4,
    async (a) => {
      try {
        const res = await fetch(RSS_URL(googleNewsQuery(a)), {
          headers: { "User-Agent": "Mozilla/5.0 (personal-invest news reader)", Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
          cache: "no-store",
        });
        if (!res.ok) return [];
        return parseGoogleNewsRss(await res.text(), a.symbol);
      } catch {
        return [];
      }
    },
    GOOGLE_NEWS_LIMITS.pauseMs,
  );
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const list of lists) {
    for (const n of list) {
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      out.push(n);
    }
  }
  return out;
}
