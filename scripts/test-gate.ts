/**
 * Tests de la puerta previa a la extraccion (puro, sin red).
 *
 * Los casos NO son inventados: son los titulares reales que produjeron las 68
 * extracciones con IA de la base de datos, con el veredicto que les dio el
 * modelo despues de pagarlos. La puerta se juzga por dos cosas:
 *
 *   1. No perder NADA de lo que resulto util (P2/P4).
 *   2. Bloquear el maximo de lo que resulto ruido (P5).
 *
 * Correr con: npm run test:gate
 */
import { isCommentaryHeadline, isOpinionOutlet, mentionsTracked, shouldExtract } from "../src/lib/intel/gate";
import type { Cluster } from "../src/lib/intel/types";

let failures = 0;
let checks = 0;
function truthy(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const TRACKED = [
  { symbol: "NVDA", name: "NVIDIA Corporation" },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "MRNA", name: "Moderna, Inc." },
  { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "META", name: "Meta Platforms, Inc." },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "NFLX", name: "Netflix, Inc." },
  { symbol: "IBM", name: "International Business Machines" },
  { symbol: "BABA", name: "Alibaba Group" },
  { symbol: "STX", name: "Seagate Technology" },
  { symbol: "SPCX", name: "SpaceX" },
  { symbol: "ORCL", name: "Oracle Corporation" },
];

let n = 0;
function cluster(source: string, url: string, headline: string, tickers: string[], kind = "news"): Cluster {
  n++;
  return {
    key: `k${n}`,
    tickers,
    occurredAt: 0,
    items: [{ id: `n${n}`, headline, url, source, summary: null, impact: null, tickers, publishedAt: 0, kind }],
  };
}

// ---------------------------------------------------------------------------
// Caso real 1: lo que SI resulto util. Ni uno solo puede bloquearse.

const UTILES: Array<[string, string, string, string[]]> = [
  ["SEC EDGAR", "https://sec.gov/x", "NVDA presenta 8-K ante la SEC: Item 8.01 (Otros eventos)", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/a", "NVDA Stock On Track To Hit Over 2-Month High – Analyst Calls $12.9B Hugging Face Deal ‘Strategically Valuable’", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/b", "From Launch Party to Federal Probe: What Went Wrong With Tesla's Cybercab in 24 Hours", ["TSLA"]],
  ["Yahoo", "https://finance.yahoo.com/c", "What Does Moderna (MRNA) Bird Flu Phase 3 Trial Mean For Its Growth?", ["MRNA"]],
  ["Yahoo", "https://finance.yahoo.com/d", "AWS Plans 2 Million More NVIDIA GPUs. Is This Better News for AMZN’s Cloud Growth or NVDA’s Backlog?", ["AMZN", "NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/e", "Tesla Launched the Cybercab Thursday, 6 Weeks After Removing Volume Production of It From This Year's Plan", ["TSLA"]],
  ["Yahoo Finance", "https://finance.yahoo.com/f", "OpenAI Cuts Cursor Off from its Models Now That Musk’s SpaceX (SPCX) Owns It", ["SPCX"]],
];

console.log("# no pierde ninguna de las extracciones que resultaron utiles (P2/P4)");
{
  for (const [src, url, head, tk] of UTILES) {
    const v = shouldExtract(cluster(src, url, head, tk), TRACKED);
    truthy(v.extract, `pasa: ${head.slice(0, 62)}… (${v.reason})`);
  }
}

// ---------------------------------------------------------------------------
// Caso real 2: lo que resulto ruido (P5). Cuanto mas se bloquee, mejor.

const RUIDO: Array<[string, string, string, string[]]> = [
  ["The Motley Fool", "https://fool.com/1", "Meet the Nvidia-Backed Stock That's Growing at a 454% Pace (It's a Screaming Buy Right Now)", ["NVDA"]],
  ["fool.com", "https://fool.com/2", "Prediction: Nvidia Stock Will Double in Under a Year", ["NVDA"]],
  ["SeekingAlpha", "https://seekingalpha.com/1", "Meta: Doesn't Have A Path For Shareholder Returns (Rating Downgrade)", ["META"]],
  ["SeekingAlpha", "https://seekingalpha.com/2", "Amazon Stock At 20x P/E: A Textbook GARP Opportunity", ["AMZN"]],
  ["SeekingAlpha", "https://seekingalpha.com/3", "Wall Street Brunch: Make Or Break Inflation For The Fed", ["NVDA"]],
  ["MarketBeat", "https://marketbeat.com/1", "67,315 Shares in International Business Machines Corporation $IBM Bought by NFJ Investment Group LLC", ["IBM"]],
  ["MarketBeat", "https://marketbeat.com/2", "TD Waterhouse Canada Inc. Buys New Position in SpaceX $SPCX", ["SPCX"]],
  ["Benzinga", "https://benzinga.com/1", "Jensen Huang's Net Worth Up $36 Billion as Nvidia Stock Eyes Surge to Record High", ["NVDA"]],
  ["ChartMill", "https://chartmill.com/1", "Waller Cracks the Door to a September Pause and the Tape Rewards the AI Software Layer", ["MSFT"]],
  ["simplywall.st", "https://simplywall.st/1", "NVIDIA (NVDA) Faces Key Legal Milestones In Copyright Lawsuit", ["NVDA"]],
  ["TIKR.com", "https://tikr.com/1", "Warner Bros Discovery Chose Paramount Over Netflix. Here’s What That Cost Netflix Stock.", ["NFLX"]],
  ["thestreet.com", "https://thestreet.com/1", "Scott Galloway issues grim SpaceX stock price forecast", ["SPCX"]],
  ["Investor's Business Daily", "https://investors.com/1", "Dow Jones Futures: U.S., Iran Exchange Attacks; Nvidia, Micron, Sandisk Flash Buy Signals", ["NVDA"]],
  ["The Globe and Mail", "https://theglobeandmail.com/1", "Target Stock at $165: Here's Why Investors Should Pause.", ["NVDA"]],
  // Sujeto ajeno: entran etiquetadas con un simbolo seguido porque el cuerpo lo menciona.
  ["Yahoo", "https://finance.yahoo.com/g", "Why Marvell Stock Rallied Today", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/h", "Why UiPath Stock Plunged Today", ["MSFT"]],
  ["Yahoo", "https://finance.yahoo.com/i", "Why Quanex Stock Skyrocketed by 22% on Friday", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/j", "Volkswagen Targets 10% Margin by 2030 With €135B Plan, 50,000 Job Cuts", ["TSLA"]],
  ["Yahoo", "https://finance.yahoo.com/k", "G42 eyes stake sale to secure critical AI chips", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/l", "AI compute provider Nscale is looking for $3.5B in pre-IPO financing", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/m", "Thinking Machines Lab Seeks $40B Valuation as Nvidia Extends Its Capital Allocator Role Into Model-Space", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/n", "Coatue Opened Positions in Intel and Cerebras. Is the AI Chip Trade Broadening Beyond NVIDIA?", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/o", "Honeywell Is Now Three Companies. Here's Which Piece I'd Actually Own.", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/p", "CEO Brian Niccol Just Announced Incredible News for Starbucks Investors", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/q", "Energy stocks could be the biggest winners of the AI boom", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/r", "Why Anthropic May Let Early Investors Sell Shares, Unlike SpaceX and Cerebras", ["SPCX"]],
  ["Yahoo", "https://finance.yahoo.com/s", "Why ASML Holding Stock Bumped 4% Higher Today", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/t", "Why Atlassian Stock Skyrocketed 92% Higher in August and Why There's Likely More to Come", ["MSFT"]],
  ["Yahoo", "https://finance.yahoo.com/u", "Prediction: IonQ Puts a Multiyear Revenue Number on the Board Tuesday", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/v", "Cramer Says the Magnificent Seven Are Finally Cheap and Most Investors Will Miss It", ["META"]],
  ["Yahoo", "https://finance.yahoo.com/w", "Jim Cramer Shares a Cautious Take on Oracle (ORCL) and Its Massive AI Buildout", ["ORCL"]],
  ["Yahoo", "https://finance.yahoo.com/x", "After A Microsoft Stock Price Spike, An Options Strategy Aims For A Robust Profit In Weeks", ["MSFT"]],
  ["Yahoo", "https://finance.yahoo.com/y", "Broadcom (AVGO) Stock Is Down After Q3 Earnings: Is It Too Soon to Buy the Dip?", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/z", "The Stock Market Just Did Something for the First Time Ever. History Says Investors Should Be Worried.", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/aa", "Dow Jones Futures: Nvidia, Micron, Sandisk Flash Buy Signals; Apple, Inflation Reports Ahead", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/ab", "David Tepper Sold 41% of His Micron Shares and It Is Still His Second-Biggest Holding", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/ac", "NuScale Just Turned AI on Itself. Here's What That Means for the Stock.", ["NVDA"]],
  ["Yahoo", "https://finance.yahoo.com/ad", "ChronoScale Says It Plans a 50 MW Microsoft AI Deployment. Can CHRN Fund the Build Without Diluting Shareholders?", ["MSFT"]],
  ["Yahoo", "https://finance.yahoo.com/ae", "AI hiring boom could turn into a surprise tailwind for software: Bernstein", ["MSFT"]],
  ["Yahoo", "https://finance.yahoo.com/af", "Stifel Revamps Microsoft Target With a Catch", ["MSFT"]],
  ["Yahoo Finance", "https://finance.yahoo.com/ag", "Michael Burry Says He Sold Alibaba, Calling It Pricey Before $10.2 Billion Share Sale", ["BABA"]],
  ["Yahoo", "https://finance.yahoo.com/ah", "Seattle Times, Newsday sue OpenAI and Microsoft over AI training", ["MSFT"]],
];

console.log("\n# bloquea el ruido que se pago por descubrir (P5)");
{
  let blocked = 0;
  const passed: string[] = [];
  for (const [src, url, head, tk] of RUIDO) {
    const v = shouldExtract(cluster(src, url, head, tk), TRACKED);
    if (v.extract) passed.push(head);
    else blocked++;
  }
  const pct = Math.round((blocked / RUIDO.length) * 100);
  console.log(`  bloqueadas ${blocked}/${RUIDO.length} (${pct}%)`);
  for (const p of passed) console.log(`     se cuela: ${p.slice(0, 78)}`);
  truthy(pct >= 70, `bloquea al menos el 70% del ruido (bloqueo real: ${pct}%)`);
}

// ---------------------------------------------------------------------------
// Reglas sueltas, para que un cambio futuro se note.

console.log("\n# reglas");
{
  eq(isOpinionOutlet("The Motley Fool", "https://fool.com/x"), true, "Motley Fool es medio de opinion");
  eq(isOpinionOutlet(null, "https://www.seekingalpha.com/x"), true, "detecta por host aunque no venga el nombre");
  eq(isOpinionOutlet("Reuters", "https://reuters.com/x"), false, "Reuters no");
  eq(isOpinionOutlet("Yahoo", "https://finance.yahoo.com/x"), false, "Yahoo no (publica agencias)");

  eq(isCommentaryHeadline("Prediction: Nvidia Stock Will Double in Under a Year"), true, "prediccion");
  eq(isCommentaryHeadline("Why Marvell Stock Rallied Today"), true, "por que subio hoy");
  eq(isCommentaryHeadline("Tesla Launched the Cybercab Thursday"), false, "un hecho no es comentario");
  eq(isCommentaryHeadline("Moderna inicia ensayo de fase 3"), false, "un hecho en espanol tampoco");

  eq(mentionsTracked("AWS Plans 2 Million More NVIDIA GPUs", ["NVDA"], TRACKED), true, "nombre de la empresa en el titular");
  eq(mentionsTracked("NVDA Stock On Track To Hit High", ["NVDA"], TRACKED), true, "simbolo en el titular");
  eq(mentionsTracked("Why Marvell Stock Rallied Today", ["NVDA"], TRACKED), false, "sujeto ajeno");
  eq(mentionsTracked("Netflix Raised U.K. Prices Again", ["NFLX"], TRACKED), true, "nombre sin simbolo");

  // Un medio de referencia pasa aunque titule como comentario: si Reuters
  // dice por que cayo una accion, es porque lo sabe.
  const ref = shouldExtract(cluster("Reuters", "https://reuters.com/x", "Why Nvidia shares fell today", ["NVDA"]), TRACKED);
  truthy(ref.extract, `tier 2 pasa siempre (${ref.reason})`);

  // Un filing pasa siempre, venga de donde venga.
  const filing = shouldExtract(cluster("SEC EDGAR", "https://sec.gov/x", "STX presenta 8-K", ["STX"], "filing"), TRACKED);
  eq(filing.reason, "documento primario", "los filings no pasan por la puerta");

  // Corroboracion: si un medio de opinion y uno normal cuentan lo mismo,
  // manda el normal.
  const mixed: Cluster = {
    key: "mix",
    tickers: ["TSLA"],
    occurredAt: 0,
    items: [
      { id: "m1", headline: "Prediction: Tesla Will Double", url: "https://fool.com/z", source: "The Motley Fool", summary: null, impact: null, tickers: ["TSLA"], publishedAt: 0, kind: "news" },
      { id: "m2", headline: "Tesla opens federal probe into Cybercab", url: "https://finance.yahoo.com/z", source: "Yahoo", summary: null, impact: null, tickers: ["TSLA"], publishedAt: 0, kind: "news" },
    ],
  };
  truthy(shouldExtract(mixed, TRACKED).extract, "un hecho real arrastra al grupo aunque venga con opinion al lado");

  // Sin activos seguidos no se inventa nada: si no reconoce el sujeto, no gasta.
  const unknown = shouldExtract(cluster("Yahoo", "https://finance.yahoo.com/zz", "Some Company Announces Layoffs", ["NVDA"]), TRACKED);
  eq(unknown.extract, false, "sujeto no reconocido: no se gasta la llamada");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
