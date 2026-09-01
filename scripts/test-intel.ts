/**
 * Test del motor de inteligencia: las etapas puras (tiers, dedup, score,
 * saneado de la salida del modelo). Sin red y sin Turso: nada llama a la IA.
 * Correr con: npm run test:intel
 */
process.env.TURSO_DATABASE_URL ||= "file:/tmp/intel-test.db";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";

import {
  applyMergePlan,
  clusterKey,
  jaccard,
  lexicalClusters,
  tokenize,
  type ExistingEvent,
} from "../src/lib/intel/dedup";
import { buildExtractPrompt, sanitizeEvent } from "../src/lib/intel/extract";
import {
  portfolioRelevance,
  priorityFor,
  scoreSignal,
  SIGNAL_WEIGHTS,
} from "../src/lib/intel/score";
import { bestTier, sourceTier } from "../src/lib/intel/sources";
import { eventSchema, type ExtractedEvent, type IntelNews } from "../src/lib/intel/types";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`  ok  ${label}`);
  }
}

function near(actual: number, expected: number, label: string, tol = 0.05) {
  checks++;
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${expected}, obtenido ${actual}`);
  } else {
    console.log(`  ok  ${label} = ${actual}`);
  }
}

function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const T0 = Date.parse("2026-09-01T10:00:00Z");
const H = 3600_000;

let seq = 0;
function n(
  headline: string,
  tickers: string[],
  at: number,
  extra: Partial<IntelNews> = {},
): IntelNews {
  seq++;
  return {
    id: `n${seq}`,
    headline,
    url: `https://example.com/${seq}`,
    source: "Yahoo",
    summary: null,
    impact: "medium",
    tickers,
    publishedAt: at,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
console.log("\n1. Tier de fuentes");
eq(sourceTier("Reuters"), 2, "Reuters es tier 2");
eq(sourceTier("Bloomberg", "https://www.bloomberg.com/x"), 2, "Bloomberg es tier 2");
eq(sourceTier(null, "https://www.sec.gov/Archives/edgar/x"), 1, "sec.gov es tier 1");
eq(sourceTier("GlobeNewswire"), 1, "comunicado oficial (wire) es tier 1");
eq(sourceTier("Yahoo"), 3, "Yahoo es tier 3");
eq(sourceTier("Fuente Rara Desconocida"), 3, "desconocida cae a tier 3");
eq(sourceTier(null), 3, "sin fuente ni url cae a tier 3");
eq(sourceTier("Twitter"), 4, "Twitter es tier 4");
eq(sourceTier(null, "https://www.reddit.com/r/wallstreetbets/x"), 4, "reddit por url es tier 4");
eq(bestTier([3, 2, 4]), 2, "bestTier elige el mejor (2)");
eq(bestTier([]), 3, "bestTier sin fuentes es 3");

// ---------------------------------------------------------------------------
console.log("\n2. Tokens");
eq(
  tokenize("Apple's Q3 résults BEAT the estimates, and raises dividend"),
  ["apple", "results", "beat", "estimates", "raises", "dividend"],
  "quita acentos, puntuacion y stopwords",
);
near(
  jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])),
  0.5,
  "jaccard {a,b,c} vs {b,c,d}",
  0.001,
);
eq(jaccard(new Set(), new Set(["a"])), 0, "jaccard con vacio es 0");

// ---------------------------------------------------------------------------
console.log("\n3. Dedup lexica");
{
  const items = [
    n("Apple beats Q3 earnings estimates, raises dividend", ["AAPL"], T0, { source: "Reuters" }),
    n("Apple beats Q3 earnings estimates and raises its dividend", ["AAPL"], T0 + 1 * H),
    n("Apple Q3 earnings beat estimates; dividend raised", ["AAPL"], T0 + 2 * H, {
      source: "CNBC",
    }),
    n("Apple faces new EU antitrust probe over App Store", ["AAPL"], T0 + 3 * H),
    n("Nvidia beats Q3 earnings estimates, raises dividend", ["NVDA"], T0 + 1 * H),
    n("Apple beats Q3 earnings estimates, raises dividend", ["AAPL"], T0 + 100 * H),
  ];
  const clusters = lexicalClusters(items);
  eq(clusters.length, 4, "6 noticias → 4 clusters (3 iguales, antitrust, NVDA, fuera de ventana)");
  const apple = clusters.find((c) => c.items.length === 3);
  truthy(apple, "el cluster de resultados de Apple tiene 3 fuentes");
  eq(apple?.occurredAt, T0, "occurredAt es la noticia mas antigua");
  eq(apple?.items.map((i) => i.id), ["n1", "n2", "n3"], "items ordenados por fecha");
  eq(apple?.tickers, ["AAPL"], "tickers del cluster");
  const nvda = clusters.find((c) => c.tickers.includes("NVDA"));
  eq(nvda?.items.length, 1, "misma frase con otro ticker NO se junta");
  const late = clusters.filter((c) => c.tickers.includes("AAPL") && c.items.length === 1);
  eq(late.length, 2, "antitrust y la repeticion fuera de ventana quedan solas");

  const k1 = clusterKey(["aapl"], T0, "Apple beats Q3 earnings estimates, raises dividend");
  const k2 = clusterKey(["AAPL"], T0 + 5 * H, "Apple beats Q3 earnings estimates, raises dividend!");
  eq(k1, k2, "clave estable: mismo dia, mismo titular normalizado, ticker en cualquier caja");
  const k3 = clusterKey(["AAPL"], T0 + 30 * H, "Apple beats Q3 earnings estimates, raises dividend");
  truthy(k1 !== k3, "clave distinta en otro dia");
  truthy(k1.startsWith("AAPL|2026-09-01|"), "formato TICKERS|dia|hash");
}

// ---------------------------------------------------------------------------
console.log("\n4. Plan de fusion (salida del modelo barato)");
{
  const clusters = lexicalClusters([
    n("Apple beats Q3 earnings estimates", ["AAPL"], T0),
    n("Apple faces EU antitrust probe", ["AAPL"], T0 + H),
    n("Apple tops quarterly expectations as iPhone sales rise", ["AAPL"], T0 + 2 * H),
    n("Tesla recalls 100k cars", ["TSLA"], T0 + 3 * H),
  ]);
  eq(clusters.length, 4, "4 clusters lexicos de partida");
  const existing: ExistingEvent[] = [
    { id: "ev-1", alias: "E1", headline: "Bruselas abre expediente a Apple", companies: ["AAPL"], occurredAt: T0 - H },
  ];
  const res = applyMergePlan(
    clusters,
    {
      groups: [
        { members: [0, 2, 9, 0], existing: null },
        { members: [1], existing: "e1" },
        { members: [3], existing: "E7" },
        { members: [2], existing: null },
      ],
    },
    existing,
  );
  eq(res.clusters.length, 2, "quedan 2 clusters: resultados fusionados + Tesla");
  const merged = res.clusters.find((c) => c.items.length === 2);
  truthy(merged, "0 y 2 se fusionan (indice 9 y repetido ignorados)");
  eq(merged?.items.map((i) => i.headline.slice(0, 5)), ["Apple", "Apple"], "fusion ordenada por fecha");
  eq(res.attached.length, 1, "1 cluster enganchado a evento existente");
  eq(res.attached[0]?.eventId, "ev-1", "alias en minusculas resuelve a ev-1");
  const tesla = res.clusters.find((c) => c.tickers.includes("TSLA"));
  truthy(tesla, "alias desconocido E7 → sigue como cluster nuevo");
  eq(applyMergePlan(clusters, null).clusters.length, 4, "sin plan, todo pasa tal cual");
}

// ---------------------------------------------------------------------------
console.log("\n5. Score de senal");
{
  near(
    Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0),
    1,
    "los pesos suman 1",
    0.0001,
  );
  const top = scoreSignal({
    materiality: 100, confidence: 100, thesisImpact: -100,
    portfolioRelevance: 100, sourceTier: 1, isNoise: false,
  });
  eq(top, { score: 100, priority: "P1" }, "todo al maximo → 100, P1");

  const mid = scoreSignal({
    materiality: 70, confidence: 60, thesisImpact: -40,
    portfolioRelevance: 100, sourceTier: 2, isNoise: false,
  });
  near(mid.score, 66.5, "caso medio: 21+12+10+15+8.5");
  eq(mid.priority, "P2", "66.5 es P2");

  const noise = scoreSignal({
    materiality: 90, confidence: 90, thesisImpact: 0,
    portfolioRelevance: 100, sourceTier: 1, isNoise: true,
  });
  eq(noise.priority, "P5", "ruido declarado nunca pasa de P5");
  truthy(noise.score <= 20, "ruido capado a 20");

  const social = scoreSignal({
    materiality: 95, confidence: 90, thesisImpact: 90,
    portfolioRelevance: 100, sourceTier: 4, isNoise: false,
  });
  eq(social.priority, "P4", "solo tier 4: como mucho P4, nunca hecho");

  const weak = scoreSignal({
    materiality: 95, confidence: 20, thesisImpact: 90,
    portfolioRelevance: 100, sourceTier: 1, isNoise: false,
  });
  eq(weak.priority, "P3", "confianza < 30: capado a 50 (P3)");

  eq(priorityFor(80), "P1", "80 → P1");
  eq(priorityFor(79.9), "P2", "79.9 → P2");
  eq(priorityFor(50), "P3", "50 → P3");
  eq(priorityFor(35), "P4", "35 → P4");
  eq(priorityFor(34.9), "P5", "34.9 → P5");
}

// ---------------------------------------------------------------------------
console.log("\n6. Relevancia de cartera");
{
  const ctx = {
    positions: [
      { symbol: "AAPL", weight: 20 },
      { symbol: "eth", weight: 5 },
    ],
    watchlist: ["NVDA"],
    known: ["AAPL", "ETH", "NVDA", "TSLA"],
  };
  eq(portfolioRelevance(["AAPL"], ctx), 100, "posicion del 20% → 100");
  eq(portfolioRelevance(["ETH"], ctx), 70, "posicion del 5% → 70");
  eq(portfolioRelevance(["NVDA"], ctx), 40, "watchlist → 40");
  eq(portfolioRelevance(["TSLA"], ctx), 15, "conocido pero sin posicion → 15");
  eq(portfolioRelevance(["MSFT"], ctx), 0, "desconocido → 0");
  eq(portfolioRelevance(["MSFT", "eth", "NVDA"], ctx), 70, "varios → el mayor");
  eq(portfolioRelevance([], ctx), 0, "sin empresas → 0");
}

// ---------------------------------------------------------------------------
console.log("\n7. Esquema y saneado de la salida del modelo");
{
  const valid: ExtractedEvent = {
    type: "earnings",
    primary_symbol: "AAPL",
    companies: ["AAPL"],
    headline: "Apple supera estimaciones del Q3",
    fact: "Apple reporto ingresos por encima de lo esperado segun Reuters.",
    inference: "Probable mejora de margen.",
    assessment: "Refuerza la tesis de servicios.",
    materiality: 60,
    confidence: 80,
    thesis_impact: 40,
    time_horizon: "medium",
    is_noise: false,
  };
  eq(eventSchema.safeParse(valid).success, true, "salida valida pasa el esquema");
  eq(
    eventSchema.safeParse({ ...valid, materiality: 150 }).success,
    false,
    "materiality 150 se rechaza",
  );
  eq(
    eventSchema.safeParse({ ...valid, thesis_impact: 40.5 }).success,
    false,
    "thesis_impact no entero se rechaza",
  );
  eq(eventSchema.safeParse({ ...valid, fact: "" }).success, false, "fact vacio se rechaza");
  eq(
    eventSchema.safeParse({ ...valid, type: "rumor" }).success,
    false,
    "tipo fuera de la taxonomia se rechaza",
  );
  eq(
    eventSchema.safeParse({ ...valid, time_horizon: "eventual" }).success,
    false,
    "horizonte fuera de lista se rechaza",
  );

  const s1 = sanitizeEvent(
    { ...valid, companies: ["aapl", "MSFT", "AAPL"], primary_symbol: "msft" },
    ["AAPL", "NVDA"],
  );
  eq(s1.companies, ["AAPL"], "simbolos no seguidos se descartan y se deduplica");
  eq(s1.primary_symbol, "AAPL", "primary no seguido cae al primero seguido");
  eq(s1.is_noise, false, "sigue sin ser ruido");

  const s2 = sanitizeEvent({ ...valid, companies: ["MSFT"], primary_symbol: "MSFT" }, ["AAPL"]);
  eq(s2.is_noise, true, "sin empresas seguidas → ruido");
  eq(s2.thesis_impact, 0, "ruido → impacto 0");
  truthy(s2.materiality <= 20, "ruido → materialidad capada");

  const s3 = sanitizeEvent({ ...valid, is_noise: true, thesis_impact: 70, materiality: 90 }, ["AAPL"]);
  eq([s3.thesis_impact, s3.materiality], [0, 20], "ruido declarado fuerza impacto 0 y materialidad 20");

  const s4 = sanitizeEvent({ ...valid, primary_symbol: "NVDA", companies: [] }, ["AAPL", "NVDA"]);
  eq(s4.companies, ["NVDA"], "primary seguido se anade a companies si faltaba");
}

// ---------------------------------------------------------------------------
console.log("\n8. Prompt de extraccion");
{
  const cluster = lexicalClusters([
    n("Apple beats Q3 earnings estimates", ["AAPL"], T0, { source: "Reuters", summary: "Ingresos arriba" }),
    n("Apple beats Q3 earnings estimates again", ["AAPL"], T0 + H, { source: "Twitter" }),
  ])[0];
  const prompt = buildExtractPrompt(cluster, {
    tracked: [
      { symbol: "AAPL", name: "Apple", assetClass: "equity" },
      { symbol: "ETH", name: "Ethereum", assetClass: "crypto" },
    ],
    positions: [
      { symbol: "AAPL", weight: 22.5, group: "equity" },
      { symbol: "ETH", weight: 3, group: "crypto" },
    ],
    watchlist: [],
    theses: new Map([["AAPL", "Servicios crecen a doble digito."]]),
  });
  truthy(prompt.includes("[1] (Reuters, tier 2, 2026-09-01)"), "fuente con tier y fecha");
  truthy(prompt.includes("[2] (Twitter, tier 4"), "tier 4 marcado en la fuente social");
  truthy(prompt.includes("Resumen: Ingresos arriba"), "incluye el resumen barato si existe");
  truthy(prompt.includes("AAPL: 22.5% de la cartera"), "posicion afectada con peso");
  truthy(!prompt.includes("ETH: 3"), "posiciones no afectadas no se incluyen");
  truthy(prompt.includes("AAPL: Servicios crecen"), "tesis del activo afectado");
  truthy(prompt.includes("AAPL (Apple, equity), ETH (Ethereum, crypto)"), "lista cerrada de simbolos");
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
if (failures > 0) {
  console.error(`${failures} fallos`);
  process.exit(1);
}
