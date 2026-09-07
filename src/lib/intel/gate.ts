import { bestTier, sourceTier } from "./sources";
import type { Cluster, IntelNews } from "./types";

/**
 * Puerta previa a la extraccion. Es la pieza que decide DONDE se gasta el
 * dinero, porque la extraccion con IA es el unico paso caro de la app: el
 * resto (conviccion, valoracion, plan, ciclo, "Que hacer") es determinista y
 * no cuesta nada.
 *
 * El problema que resuelve, medido sobre las 68 extracciones reales: 60 de
 * ellas salieron P5 (ruido), con materialidad media de 8 sobre 100. Es decir,
 * se pagaba una llamada para que el modelo contestase "aqui no ha pasado
 * nada". La informacion para saberlo estaba disponible ANTES y gratis: quien
 * publica y de quien habla el titular.
 *
 * Solo se bloquea lo que se puede descartar sin leerlo. Ante la duda, se
 * extrae: una alerta perdida cuesta mas que una llamada de mas.
 */

export type GateVerdict = {
  extract: boolean;
  /** Por que, para que aparezca en las estadisticas de la pasada. */
  reason: string;
};

/**
 * Medios de comentario y recomendacion. No es un juicio sobre su calidad:
 * publican opinion y analisis, no primicias, asi que un hecho suyo llega
 * siempre antes por otra via. En los datos reales, TODOS los eventos cuyas
 * fuentes eran solo de esta lista salieron P5, sin una sola excepcion.
 */
export const OPINION_HOSTS = [
  "fool.com",
  "seekingalpha.com",
  "marketbeat.com",
  "benzinga.com",
  "chartmill.com",
  "simplywall.st",
  "tikr.com",
  "thestreet.com",
  "zacks.com",
  "investorplace.com",
  "247wallst.com",
  "insidermonkey.com",
  "gurufocus.com",
  "investing.com",
  "barchart.com",
  "stocktwits.com",
];

export const OPINION_NAMES = [
  "the motley fool",
  "motley fool",
  "fool.com",
  "seekingalpha",
  "seeking alpha",
  "marketbeat",
  "benzinga",
  "chartmill",
  "simplywall.st",
  "simply wall st",
  "tikr.com",
  "tikr",
  "thestreet.com",
  "thestreet",
  "zacks",
  "investorplace",
  "24/7 wall st",
  "insider monkey",
  "gurufocus",
  "barchart",
  "stocktwits",
];

/**
 * Titulares que anuncian comentario, no hecho. Se aplican SOLO a medios de
 * tier 3 o peor: si Reuters titula "Why X fell today" es porque lo sabe.
 */
const COMMENTARY_PATTERNS: RegExp[] = [
  /^prediction\b/i,
  /^why\s+.+\s+(stock|shares)\s+(rallied|plunged|jumped|fell|dropped|soared|skyrocketed|slipped|rose|sank)/i,
  /^(meet|here'?s|this is)\s+the\b/i,
  /\b(screaming|no-?brainer)\s+buy\b/i,
  /\bshould\s+(you|investors)\b/i,
  /\bis\s+it\s+(too\s+)?(soon|late)\s+to\b/i,
  /\b(buy|sell)\s+the\s+dip\b/i,
  /\b(cramer|jim cramer)\b/i,
  /\b(rating\s+downgrade|price\s+target\s+(raised|cut|revamp))/i,
  /\b\d+\s+(stocks?|reasons?)\s+(to|you)\b/i,
  /\bbest\s+stocks?\s+to\b/i,
  /\b(options?\s+strategy|options?\s+play)\b/i,
  /\bdow\s+jones\s+futures\b/i,
  /\bwall\s+street\s+(brunch|breakfast|lunch)\b/i,
  /\b(shares?\s+(in|of)\s+.+\s+(bought|sold)\s+by|position\s+in\s+.+\s+by)\b/i,
  /\b(top\s+buy\s+points?|flash\s+buy\s+signals?)\b/i,
];

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Puro: ¿este medio publica comentario en vez de primicias? */
export function isOpinionOutlet(source: string | null, url: string): boolean {
  const h = host(url);
  if (h && OPINION_HOSTS.some((o) => h === o || h.endsWith(`.${o}`))) return true;
  const name = (source ?? "").toLowerCase().trim();
  return name !== "" && OPINION_NAMES.some((n) => name === n || name.includes(n));
}

/** Puro: ¿el titular anuncia comentario en vez de un hecho? */
export function isCommentaryHeadline(headline: string): boolean {
  return COMMENTARY_PATTERNS.some((re) => re.test(headline));
}

/**
 * ¿El titular habla de una empresa seguida, o solo la menciona de pasada?
 * "Why Marvell Stock Rallied Today" entra al sistema etiquetada NVDA porque
 * el cuerpo la nombra, pero el sujeto es otro. Se compara con el simbolo y
 * con la primera palabra distintiva del nombre ("NVIDIA Corp" -> "nvidia").
 */
export function mentionsTracked(
  headline: string,
  tickers: string[],
  tracked: Array<{ symbol: string; name: string }>,
): boolean {
  const h = ` ${headline.toLowerCase()} `;
  const own = new Set(tickers.map((t) => t.toUpperCase()));
  for (const t of tracked) {
    if (!own.has(t.symbol.toUpperCase())) continue;
    if (new RegExp(`\\b${escapeRe(t.symbol)}\\b`, "i").test(headline)) return true;
    const word = firstWord(t.name);
    if (word.length >= 3 && h.includes(` ${word} `)) return true;
    // "Netflix Raised U.K. Prices" -> "netflix's", "netflix," tambien valen.
    if (word.length >= 3 && new RegExp(`\\b${escapeRe(word)}\\b`, "i").test(headline)) return true;
  }
  return false;
}

function firstWord(name: string): string {
  return (name.split(/[\s,.]+/)[0] ?? "").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide si un grupo merece la llamada cara. Los filings y los medios de
 * referencia pasan siempre; lo demas tiene que hablar de una empresa seguida
 * y no ser comentario.
 */
export function shouldExtract(
  cluster: Cluster,
  tracked: Array<{ symbol: string; name: string }>,
): GateVerdict {
  const items = cluster.items;
  if (items.length === 0) return { extract: false, reason: "grupo vacio" };

  // Documento primario: siempre. Es la voz de la empresa o del regulador.
  if (items.some((i) => i.kind === "filing")) return { extract: true, reason: "documento primario" };

  const tier = bestTier(items.map((i) => sourceTier(i.source, i.url)));
  if (tier <= 2) return { extract: true, reason: "fuente de referencia" };

  // A partir de aqui solo hay medios secundarios o peores.
  const substantive = items.filter((i) => !isOpinionOutlet(i.source, i.url));
  if (substantive.length === 0) {
    return { extract: false, reason: "solo medios de opinion y recomendacion" };
  }

  const onTopic = substantive.filter((i) => mentionsTracked(i.headline, cluster.tickers, tracked));
  if (onTopic.length === 0) {
    return { extract: false, reason: "ninguna empresa seguida es el sujeto del titular" };
  }

  if (onTopic.every((i) => isCommentaryHeadline(i.headline))) {
    return { extract: false, reason: "titulares de comentario, no de hecho" };
  }

  return { extract: true, reason: "habla de una empresa seguida" };
}

/** Reparte un lote en lo que se extrae y lo que se descarta, con el motivo. */
export function partitionByGate(
  clusters: Cluster[],
  tracked: Array<{ symbol: string; name: string }>,
): { pass: Cluster[]; blocked: Array<{ cluster: Cluster; reason: string }> } {
  const pass: Cluster[] = [];
  const blocked: Array<{ cluster: Cluster; reason: string }> = [];
  for (const c of clusters) {
    const v = shouldExtract(c, tracked);
    if (v.extract) pass.push(c);
    else blocked.push({ cluster: c, reason: v.reason });
  }
  return { pass, blocked };
}

export type { IntelNews };
