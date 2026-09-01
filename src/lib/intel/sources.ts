import type { SourceTier } from "./types";

/**
 * Fiabilidad por fuente. No mide calidad editorial: mide cuanto puede pesar
 * lo que dice como HECHO.
 *
 *  1  Primaria: reguladores y filings (SEC, Fed, BCE...).
 *  2  Medios financieros de referencia con verificacion propia, y comunicados
 *     oficiales por wire (son la voz de la empresa, pero autoreportados y
 *     cualquiera con tarjeta puede emitir uno: no merecen el tier 1).
 *  3  Secundarios, agregadores y opinion. Lo normal cuando no se conoce.
 *  4  Social / no verificado. Nunca se presenta como hecho.
 *
 * El host de la URL manda y se compara por sufijo exacto (`x.com` no puede
 * casar con `ir.netflix.com`, `ft.com` no casa con `news.microsoft.com`).
 * El nombre de la fuente es el respaldo y se compara por palabra completa.
 */
type Rule = { tier: SourceTier; hosts: string[]; names: string[] };

const RULES: Rule[] = [
  {
    tier: 1,
    hosts: [
      "sec.gov",
      "federalreserve.gov",
      "ecb.europa.eu",
      "europa.eu",
      "treasury.gov",
      "ftc.gov",
      "justice.gov",
      "fda.gov",
      "cnmv.es",
      "bde.es",
    ],
    names: [
      "sec",
      "securities and exchange commission",
      "federal reserve",
      "european central bank",
      "cnmv",
    ],
  },
  {
    tier: 2,
    hosts: [
      "reuters.com",
      "bloomberg.com",
      "ft.com",
      "wsj.com",
      "dowjones.com",
      "cnbc.com",
      "barrons.com",
      "apnews.com",
      "nikkei.com",
      "economist.com",
      "marketwatch.com",
      "theinformation.com",
      "handelsblatt.com",
      "expansion.com",
      "eleconomista.es",
      "globenewswire.com",
      "prnewswire.com",
      "businesswire.com",
      "accesswire.com",
      "newsfilecorp.com",
    ],
    names: [
      "reuters",
      "thomson reuters",
      "bloomberg",
      "financial times",
      "wall street journal",
      "wsj",
      "dow jones",
      "cnbc",
      "barron's",
      "barrons",
      "associated press",
      "ap news",
      "nikkei",
      "the economist",
      "marketwatch",
      "the information",
      "handelsblatt",
      "expansion",
      "el economista",
      "globenewswire",
      "pr newswire",
      "prnewswire",
      "business wire",
      "businesswire",
      "accesswire",
      "newsfile",
    ],
  },
  {
    tier: 4,
    hosts: [
      "twitter.com",
      "x.com",
      "t.co",
      "reddit.com",
      "medium.com",
      "substack.com",
      "youtube.com",
      "youtu.be",
      "t.me",
      "telegram.org",
      "discord.com",
      "stocktwits.com",
      "4chan.org",
      "tiktok.com",
      "facebook.com",
      "threads.net",
    ],
    names: [
      "twitter",
      "x",
      "reddit",
      "medium",
      "substack",
      "youtube",
      "telegram",
      "discord",
      "stocktwits",
      "4chan",
      "tiktok",
      "facebook",
      "threads",
    ],
  },
];

export function sourceTier(source: string | null | undefined, url?: string): SourceTier {
  const host = hostOf(url);
  if (host) {
    for (const rule of RULES) {
      if (rule.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return rule.tier;
    }
  }
  const name = normalizeName(source);
  if (name) {
    for (const rule of RULES) {
      if (rule.names.some((n) => name.includes(` ${n} `))) return rule.tier;
    }
  }
  return 3;
}

/** El mejor tier (numero mas bajo) del grupo de fuentes. */
export function bestTier(tiers: SourceTier[]): SourceTier {
  if (tiers.length === 0) return 3;
  return Math.min(...tiers) as SourceTier;
}

/** Fiabilidad 0..100 para el score de senal. */
export const TIER_RELIABILITY: Record<SourceTier, number> = {
  1: 100,
  2: 85,
  3: 60,
  4: 25,
};

export function hostOf(url?: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** " Reuters Blog " → " reuters blog " para casar por palabra completa. */
function normalizeName(source: string | null | undefined): string {
  const s = (source ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? ` ${s} ` : "";
}
