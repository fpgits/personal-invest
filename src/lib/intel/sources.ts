import type { SourceTier } from "./types";

/**
 * Fiabilidad por fuente. No mide calidad editorial: mide cuanto puede pesar
 * lo que dice como HECHO.
 *
 *  1  Primaria: reguladores, filings, comunicados oficiales de la empresa.
 *  2  Medios financieros de referencia con verificacion propia.
 *  3  Secundarios, agregadores y opinion. Lo normal cuando no se conoce.
 *  4  Social / no verificado. Nunca se presenta como hecho.
 *
 * Se compara en minusculas por subcadena contra el nombre de la fuente y el
 * host de la URL, asi "Reuters", "reuters.com" y "Thomson Reuters" caen igual.
 */
const TIERS: Array<[SourceTier, string[]]> = [
  [
    1,
    [
      "sec.gov",
      "sec ",
      "securities and exchange",
      "federalreserve",
      "federal reserve",
      "ecb.europa",
      "europa.eu",
      "treasury.gov",
      "ftc.gov",
      "doj.gov",
      "fda.gov",
      "globenewswire",
      "prnewswire",
      "pr newswire",
      "businesswire",
      "business wire",
      "accesswire",
      "newsfile",
    ],
  ],
  [
    2,
    [
      "reuters",
      "bloomberg",
      "financial times",
      "ft.com",
      "wsj",
      "wall street journal",
      "dow jones",
      "cnbc",
      "barron",
      "associated press",
      "apnews",
      "nikkei",
      "the economist",
      "marketwatch",
      "the information",
      "handelsblatt",
      "expansion",
      "el economista",
    ],
  ],
  [
    4,
    [
      "twitter",
      "x.com",
      "reddit",
      "medium.com",
      "substack",
      "youtube",
      "telegram",
      "discord",
      "stocktwits",
      "4chan",
      "tiktok",
      "facebook",
    ],
  ],
];

export function sourceTier(source: string | null | undefined, url?: string): SourceTier {
  const hay = `${source ?? ""} ${hostOf(url)}`.toLowerCase();
  if (!hay.trim()) return 3;
  for (const [tier, needles] of TIERS) {
    if (needles.some((n) => hay.includes(n))) return tier;
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

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
