/**
 * Test de las fuentes primarias y de la calibracion, sin red:
 *  - EDGAR: HTML → texto, parseo de submissions, clasificacion de filings
 *  - Finnhub: normalizacion de metricas y texto de fundamentales
 *  - etiquetado de noticias cripto
 *  - tesis: esquema, render, saneado, prompt de contraste y propuesta
 *  - calibracion: informe y sugerencia de pesos
 * Correr con: npm run test:sources
 */
process.env.TURSO_DATABASE_URL ||= "file:/tmp/sources-test.db";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";

import { classifyFiling, htmlToText, padCik, parseSubmissions } from "../src/lib/edgar";
import { fundamentalsToText, parseFundamentals } from "../src/lib/fundamentals";
import { normalizeWeights, suggestWeights, summarize, type CalibrationRow } from "../src/lib/intel/calibration";
import { scoreSignal, SIGNAL_WEIGHTS } from "../src/lib/intel/score";
import { normalizeMetrics } from "../src/lib/market/finnhub";
import { tagCrypto } from "../src/lib/news";
import {
  buildCheckPrompt,
  parseStructure,
  renderThesisMarkdown,
  sanitizeStructure,
  thesisCheckSchema,
  thesisStructureSchema,
  toProposalPayload,
  type ThesisView,
} from "../src/lib/thesis";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
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

// ---------------------------------------------------------------------------
console.log("\n1. EDGAR: HTML a texto");
{
  const html = `<html><head><title>x</title><style>p{}</style></head><body>
    <ix:header><ix:hidden>secret stuff</ix:hidden></ix:header>
    <script>alert(1)</script>
    <p>Item&nbsp;2.02 &amp; Results of <b>Operations</b>.</p><div>Revenue was $1,234&#8212;up 5%.</div>
    <table><tr><td>Q3</td><td>1,000</td></tr></table>
    <!-- comment -->
  </body></html>`;
  const text = htmlToText(html);
  truthy(!text.includes("secret stuff"), "descarta la cabecera iXBRL oculta");
  truthy(!text.includes("alert("), "descarta scripts");
  truthy(text.includes("Item 2.02 & Results of Operations."), "decodifica entidades y quita etiquetas");
  truthy(text.includes("$1,234—up 5%."), "decodifica entidades numericas");
  truthy(/Q3 1,000/.test(text), "celdas de tabla separadas");
  eq(htmlToText("<p>" + "a".repeat(50) + "</p>", 10).length, 11, "recorta al maximo con elipsis");
}

console.log("\n2. EDGAR: submissions y clasificacion");
{
  const sub = {
    filings: {
      recent: {
        form: ["8-K", "10-Q", "4", "8-K", "SC 13D", "8-K"],
        filingDate: ["2026-08-30", "2026-08-01", "2026-08-29", "2026-08-28", "2026-08-27", "2026-06-01"],
        accessionNumber: ["0000320193-26-000090", "0000320193-26-000080", "0000320193-26-000085", "0000320193-26-000084", "0001234567-26-000001", "0000320193-26-000010"],
        primaryDocument: ["aapl-8k.htm", "aapl-10q.htm", "form4.xml", "aapl-8k-b.htm", "sc13d.htm", "old.htm"],
        primaryDocDescription: ["8-K", "10-Q", "4", "8-K", "SC 13D", "8-K"],
        items: ["2.02,9.01", "", "", "9.01", "", "5.02"],
      },
    },
  };
  const since = Date.parse("2026-08-20T00:00:00Z");
  const filings = parseSubmissions(sub, "0000320193", since);
  eq(filings.map((f) => f.form), ["8-K", "8-K", "SC 13D"], "solo formularios de interes y recientes, mas reciente primero");
  eq(filings[0].items, ["2.02", "9.01"], "items parseados");
  eq(
    filings[0].url,
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/aapl-8k.htm",
    "URL del documento sin ceros ni guiones",
  );
  eq(classifyFiling("8-K", ["2.02", "9.01"]), { impact: "high", label: "Item 2.02 (Resultados de operaciones)", skip: false }, "8-K de resultados es alto");
  eq(classifyFiling("8-K", ["9.01"]).skip, true, "8-K solo con anexos se descarta");
  eq(classifyFiling("8-K", ["7.01"]).impact, "medium", "Reg FD es medio");
  eq(classifyFiling("8-K", ["5.07"]).skip, true, "votacion de accionistas se descarta");
  eq(classifyFiling("10-Q", []), { impact: "high", label: "Informe trimestral (10-Q)", skip: false }, "10-Q es alto");
  eq(classifyFiling("4", []).skip, true, "formulario 4 no interesa");
  eq(padCik(320193), "0000320193", "padCik rellena a 10 digitos");
  eq(parseSubmissions({}, "0000320193", since), [], "sin filings → vacio");
}

console.log("\n3. Finnhub: metricas y texto de fundamentales");
{
  const m = normalizeMetrics({
    marketCapitalization: 3_400_000,
    peBasicExclExtraTTM: 31.2,
    revenueGrowthTTMYoy: 6.1,
    operatingMarginTTM: 31.5,
    "totalDebt/totalEquityQuarterly": 1.45,
    "52WeekHigh": 260,
    "52WeekLow": 169,
    beta: "no-number",
  });
  eq(m.pe, 31.2, "P/E desde la clave TTM");
  eq(m.beta, null, "valor no numerico → null");
  eq(m.ps, null, "metrica ausente → null");
  const view = parseFundamentals({
    assetId: "a",
    metrics: JSON.stringify(m),
    earnings: JSON.stringify([{ period: "2026-06-30", actual: 1.57, estimate: 1.5, surprisePct: 4.7 }]),
    nextEarningsAt: Date.parse("2026-10-29T00:00:00Z"),
    updatedAt: Date.parse("2026-09-01T00:00:00Z"),
  });
  const text = fundamentalsToText(view);
  truthy(text.includes("cap. 3.40T"), "capitalizacion en billones");
  truthy(text.includes("P/E 31.2"), "P/E en el texto");
  truthy(text.includes("margen operativo 31.5%"), "margen en porcentaje");
  truthy(text.includes("2026-06-30: BPA 1.57 (+4.7% vs est.)"), "trimestre con sorpresa");
  truthy(text.includes("proximos resultados 2026-10-29"), "proxima fecha");
  truthy(!text.includes("P/S"), "metricas ausentes no aparecen (nada inventado)");
  eq(fundamentalsToText(null), "", "sin datos → cadena vacia");
}

console.log("\n4. Etiquetado de noticias cripto");
{
  const tracked = [
    { symbol: "ETH", name: "Ethereum" },
    { symbol: "BTC", name: "Bitcoin" },
    { symbol: "SOL", name: "Solana" },
    { symbol: "OP", name: "Optimism" },
  ];
  eq(tagCrypto("Ethereum ETF inflows hit record", tracked), ["ETH"], "por nombre");
  eq(tagCrypto("BTC and ETH slide as dollar strengthens", tracked).sort(), ["BTC", "ETH"], "por simbolo, varios");
  eq(tagCrypto("The Ethereal festival", tracked), [], "prefijo de nombre no cuenta");
  eq(tagCrypto("Top op-eds on markets", tracked), [], "simbolo de 2 letras no se usa (OP)");
  eq(tagCrypto("Optimism grows among traders", tracked), [], "nombres que son palabras corrientes no cuentan por nombre");
  eq(tagCrypto("Ethereum L2 Optimism ships upgrade; OP token up", tracked).sort(), ["ETH"], "un simbolo de 2 letras con nombre ambiguo queda sin cobertura (limite conocido)");
  eq(tagCrypto("solana network halts", tracked), ["SOL"], "nombre es insensible a mayusculas");
  eq(tagCrypto("BTCUSD pair spikes", tracked), [], "simbolo pegado a otras letras no cuenta");
}

console.log("\n5. Tesis: esquema, render y saneado");
{
  const structure = {
    summary: "Apple vende hardware con margen de servicios creciente.",
    bull: ["Servicios crecen a doble digito"],
    bear: ["Dependencia del iPhone"],
    assumptions: [
      { metric: "Crecimiento de servicios", statement: "Servicios crece mas del 10% anual", target: 10, comparator: "gte" as const, unit: "%" },
      { metric: "Margen operativo", statement: "Se mantiene por encima del 28%. Deberias comprar ahora.", target: 28, comparator: "gte" as const, unit: "%" },
    ],
    breakers: ["Dos trimestres con servicios cayendo"],
    watch: ["Resultados de octubre"],
  };
  eq(thesisStructureSchema.safeParse(structure).success, true, "estructura valida");
  eq(thesisStructureSchema.safeParse({ ...structure, assumptions: [] }).success, false, "sin supuestos se rechaza");
  eq(thesisStructureSchema.safeParse({ ...structure, breakers: [] }).success, false, "sin rompe-tesis se rechaza");
  const clean = sanitizeStructure(structure);
  truthy(clean.assumptions[1].statement.includes("[Frase retirada"), "consejo de operar retirado del supuesto");
  const md = renderThesisMarkdown(clean, [
    { metric: "Crecimiento de servicios", statement: "x", status: "at_risk" },
  ]);
  truthy(md.includes("## Supuestos") && md.includes("[En riesgo] Crecimiento de servicios"), "markdown con estados");
  truthy(md.includes("## Que la rompe"), "markdown con rompe-tesis");
  eq(parseStructure("{not json"), null, "JSON roto → null");
  eq(parseStructure(JSON.stringify({ summary: "x" })), null, "estructura incompleta → null");
  truthy(parseStructure(JSON.stringify(clean)), "estructura valida se recupera");
}

console.log("\n6. Tesis: contraste con un evento y propuesta");
{
  const view: ThesisView = {
    thesis: {
      id: "t1", assetId: "a1", thesis: "md", conviction: 4, targetPrice: null, horizon: null,
      generatedBy: "m", structure: JSON.stringify({
        summary: "Resumen", bull: ["b"], bear: ["c"], assumptions: [], breakers: ["Perdida del cliente X"], watch: [],
      }), updatedAt: 0,
    },
    asset: { id: "a1", symbol: "AAPL", name: "Apple", assetClass: "equity", currency: "USD", providerId: "AAPL", logoUrl: null, cik: null, createdAt: 0 },
    structure: { summary: "Resumen", bull: ["b"], bear: ["c"], assumptions: [], breakers: ["Perdida del cliente X"], watch: [] },
    assumptions: [
      { id: "as1", thesisId: "t1", metric: "Margen operativo", statement: ">28%", target: 28, comparator: "gte", unit: "%", status: "unknown", note: null, sortOrder: 0, updatedAt: 0 },
    ],
    pending: [],
    history: [],
    fundamentals: null,
  };
  const ev = {
    id: "e1", type: "earnings", primaryAssetId: "a1", companies: '["AAPL"]', headline: "Margen cae al 25%",
    fact: "La empresa reporto margen operativo del 25%.", inference: "", assessment: "Presion en margenes.",
    materiality: 70, confidence: 85, thesisImpact: -40, timeHorizon: "medium", portfolioRelevance: 100,
    sourceTier: 1, signalScore: 80, priority: "P1", occurredAt: 0, clusterKey: "k", model: null, promptVersion: null,
    feedback: null, feedbackAt: null, createdAt: 0,
  };
  const prompt = buildCheckPrompt(view, ev);
  truthy(prompt.includes("id=as1 · Margen operativo"), "el prompt lleva los ids de los supuestos");
  truthy(prompt.includes("Rompe-tesis: Perdida del cliente X"), "y los rompe-tesis");
  truthy(prompt.includes("Hecho: «La empresa reporto margen operativo del 25%.»"), "y el hecho entre comillas");

  const check = thesisCheckSchema.parse({
    material: true,
    summary: "El margen cae por debajo del supuesto.",
    assumption_updates: [
      { id: "as1", status: "broken", reason: "25% < 28%" },
      { id: "fantasma", status: "on_track", reason: "inventado" },
    ],
    breaker_hit: false,
    breaker: null,
    conviction_delta: -1.4,
  });
  eq(check.conviction_delta, -1, "delta redondeado");
  const payload = toProposalPayload(check, view);
  eq(payload?.assumption_updates.map((u) => u.id), ["as1"], "ids inexistentes se descartan");
  eq(payload?.conviction_delta, -1, "delta conservado");
  eq(toProposalPayload({ ...check, material: false }, view), null, "no material → sin propuesta");
  eq(
    toProposalPayload({ ...check, assumption_updates: [{ id: "fantasma", status: "broken", reason: "x" }], conviction_delta: 0, breaker_hit: false }, view),
    null,
    "solo ids inventados y sin delta → sin propuesta",
  );
}

console.log("\n7. Calibracion");
{
  const row = (priority: CalibrationRow["priority"], feedback: CalibrationRow["feedback"], over: Partial<CalibrationRow> = {}): CalibrationRow => ({
    priority, feedback, materiality: 50, confidence: 50, thesisImpact: 0, portfolioRelevance: 50, sourceTier: 3, ...over,
  });
  const rows: CalibrationRow[] = [
    row("P1", "useful"), row("P1", "useful"), row("P1", "late"),
    row("P2", "useful"), row("P2", "not_useful"), row("P2", "known"), row("P2", "irrelevant"),
    row("P3", "speculative"),
  ];
  const rep = summarize(rows, 40);
  eq(rep.rated, 8, "8 valorados");
  eq(rep.total, 40, "40 en total");
  const p1 = rep.byPriority.find((p) => p.priority === "P1")!;
  eq([p1.rated, p1.useful, Math.round((p1.precision ?? 0) * 100)], [3, 2, 67], "P1: 2 de 3 utiles");
  eq(rep.byPriority.find((p) => p.priority === "P5")!.precision, null, "P5 sin datos → null");
  eq(rep.byPriority.find((p) => p.priority === "P2")!.byFeedback.known, 1, "desglose por feedback");

  eq(suggestWeights(rows).weights, null, "con pocas muestras no se sugiere");
  // 40 muestras: los utiles tienen materialidad y relevancia altas; el resto no.
  const many: CalibrationRow[] = [];
  for (let i = 0; i < 20; i++) many.push(row("P2", "useful", { materiality: 80, portfolioRelevance: 90, thesisImpact: 60 }));
  for (let i = 0; i < 20; i++) many.push(row("P2", "not_useful", { materiality: 40, portfolioRelevance: 30, thesisImpact: 10 }));
  const s = suggestWeights(many);
  truthy(s.weights, "con 40 muestras hay sugerencia");
  const sum = Object.values(s.weights!).reduce((a, b) => a + b, 0);
  truthy(Math.abs(sum - 1) < 0.01, "los pesos sugeridos suman 1");
  truthy(s.weights!.materiality > s.weights!.confidence, "materialidad (que separa) pesa mas que confianza (que no)");
  truthy(Object.values(s.weights!).every((w) => w >= 0.05), "ningun peso por debajo del suelo");

  const same: CalibrationRow[] = [];
  for (let i = 0; i < 20; i++) same.push(row("P2", "useful"));
  for (let i = 0; i < 20; i++) same.push(row("P2", "not_useful"));
  eq(suggestWeights(same).weights, null, "si nada separa, no hay sugerencia");

  eq(normalizeWeights({ materiality: 2, confidence: 1, thesisImpact: 1, portfolioRelevance: 0, sourceReliability: 0 }), { materiality: 0.5, confidence: 0.25, thesisImpact: 0.25, portfolioRelevance: 0, sourceReliability: 0 }, "pesos a mano se normalizan");
  eq(normalizeWeights({ materiality: "x" }), null, "pesos invalidos → null");
  const custom = { materiality: 1, confidence: 0, thesisImpact: 0, portfolioRelevance: 0, sourceReliability: 0 };
  eq(scoreSignal({ materiality: 90, confidence: 100, thesisImpact: 0, portfolioRelevance: 0, sourceTier: 1, isNoise: false, distinctHosts: 2 }, custom).score, 90, "scoreSignal usa los pesos inyectados");
  eq(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0), 1, "pesos por defecto suman 1");
}

console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
if (failures > 0) {
  console.error(`${failures} fallos`);
  process.exit(1);
}
