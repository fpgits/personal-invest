/**
 * Tests de las fuentes nuevas (puro, sin red):
 *  - Form 4: parseo del XML ownershipDocument (varios firmantes, flag 10b5-1,
 *    una o varias operaciones) y senales agregadas por ventana;
 *  - Google News RSS: parseo, medio original, limpieza del titular, antiguedad;
 *  - EDGAR: filtro de formularios (Form 4) y clasificacion de 13D/13G.
 * Correr con: npm run test:insiders
 */
import { classifyFiling, parseSubmissions } from "../src/lib/edgar";
import { insiderSignals, parseForm4, rawForm4Url, type InsiderSignal } from "../src/lib/insiders";
import { googleNewsQuery, parseGoogleNewsRss } from "../src/lib/market/google-news";

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

const DAY = 86400_000;
const NOW = Date.parse("2026-09-05T00:00:00Z");

const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-08-28</periodOfReport>
  <aff10b5One>0</aff10b5One>
  <issuer>
    <issuerCik>0001045810</issuerCik>
    <issuerName>NVIDIA CORP</issuerName>
    <issuerTradingSymbol>NVDA</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001234</rptOwnerCik><rptOwnerName>HUANG JEN HSUN</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>President and CEO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-08-28</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2,000</value></transactionShares>
        <transactionPricePerShare><value>230.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>100000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-08-28</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>230.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

console.log("\n# parseForm4");
{
  const f = parseForm4(FORM4)!;
  truthy(f, "parsea el documento");
  eq([f.symbol, f.issuerCik, f.periodOfReport], ["NVDA", "0001045810", "2026-08-28"], "emisor y periodo");
  eq(f.transactions.length, 2, "dos operaciones no derivadas");
  const p = f.transactions[0];
  eq([p.ownerName, p.ownerRole, p.officerTitle], ["HUANG JEN HSUN", "officer", "President and CEO"], "firmante y rol");
  eq([p.code, p.acquired, p.shares, p.price, p.value, p.postShares, p.planned], ["P", true, 2000, 230.5, 461000, 100000, false], "compra: cifras (con coma en shares)");
  eq([f.transactions[1].code, f.transactions[1].acquired], ["F", false], "retencion fiscal como dispuesta");

  // Una sola operacion (objeto, no array) y flag 10b5-1 en true.
  const blocks = FORM4.split("<nonDerivativeTransaction>");
  // blocks[0] = cabecera, blocks[1] = 1a operacion + cierre parcial, blocks[2] = 2a operacion + cierre.
  const single = (blocks[0] + "<nonDerivativeTransaction>" + blocks[1] + "</nonDerivativeTable>\n</ownershipDocument>")
    .replace("<aff10b5One>0</aff10b5One>", "<aff10b5One>true</aff10b5One>")
    .replace(/<\/nonDerivativeTransaction>\s*$/, "</nonDerivativeTransaction>");
  const s = parseForm4(single)!;
  eq(s.transactions.length, 1, "una operacion suelta se trata como lista");
  eq(s.transactions[0].planned, true, "10b5-1 marcado");
  eq(parseForm4("<html>no es un form 4</html>"), null, "sin ownershipDocument → null");
  eq(rawForm4Url("https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/xslF345X05/wk-form4_1.xml"), "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/wk-form4_1.xml", "quita el prefijo de hoja de estilo");
}

type Tx = Parameters<typeof insiderSignals>[0][number];
function tx(over: Partial<Tx> & { accession: string; code: string; value: number }): Tx {
  return {
    symbol: "NVDA",
    ownerName: "A",
    ownerRole: "officer",
    officerTitle: "CFO",
    acquired: over.code === "P",
    shares: Math.round(over.value / 100),
    postShares: 50_000,
    planned: false,
    transactionAt: NOW - 2 * DAY,
    filedAt: NOW - 1 * DAY,
    url: `https://sec.gov/${over.accession}.xml`,
    ...over,
  };
}
const kinds = (s: InsiderSignal[]) => s.map((x) => x.kind);

console.log("\n# insiderSignals");
{
  const cluster = insiderSignals(
    [tx({ accession: "a1", code: "P", value: 60_000, ownerName: "A" }), tx({ accession: "a2", code: "P", value: 40_000, ownerName: "B", ownerRole: "director" })],
    new Set(["a2"]),
    NOW,
  );
  eq(kinds(cluster), ["cluster_buy"], "dos compradores distintos → compra agrupada");
  truthy(cluster[0].headline.includes("2 directivos") && cluster[0].totalValue === 100_000, "titular y total");
  eq(cluster[0].latestAccession, "a2", "clave del filing mas reciente");

  eq(kinds(insiderSignals([tx({ accession: "b1", code: "P", value: 150_000 })], new Set(["b1"]), NOW)), ["big_buy"], "una compra grande → big_buy");
  eq(kinds(insiderSignals([tx({ accession: "c1", code: "P", value: 30_000 })], new Set(["c1"]), NOW)), ["buy"], "compra modesta → buy");
  eq(kinds(insiderSignals([tx({ accession: "d1", code: "P", value: 5_000 })], new Set(["d1"]), NOW)), [], "compra minima → nada");
  eq(kinds(insiderSignals([tx({ accession: "e1", code: "A", value: 500_000, acquired: true })], new Set(["e1"]), NOW)), [], "concesion de acciones no es compra");
  eq(kinds(insiderSignals([tx({ accession: "f1", code: "P", value: 150_000 })], new Set(["otro"]), NOW)), [], "sin filing nuevo no se reemite");
  eq(kinds(insiderSignals([tx({ accession: "g1", code: "P", value: 150_000, transactionAt: NOW - 40 * DAY })], new Set(["g1"]), NOW)), [], "fuera de la ventana de 30 dias");

  eq(kinds(insiderSignals([tx({ accession: "h1", code: "S", value: 2_000_000, planned: true })], new Set(["h1"]), NOW)), [], "venta bajo 10b5-1 no cuenta");
  eq(kinds(insiderSignals([tx({ accession: "i1", code: "S", value: 2_000_000 })], new Set(["i1"]), NOW)), ["big_sell"], "venta grande discrecional → big_sell");
  const half = insiderSignals([tx({ accession: "j1", code: "S", value: 300_000, shares: 3000, postShares: 1000 })], new Set(["j1"]), NOW);
  eq(kinds(half), ["half_position_sell"], "vende 75% de su posicion → half_position_sell");
  truthy(half[0].headline.includes("75%") && half[0].thesisImpact < 0, "titular con porcentaje y signo negativo");
  eq(kinds(insiderSignals([tx({ accession: "k1", code: "S", value: 2_000_000, ownerRole: "other" })], new Set(["k1"]), NOW)), [], "ventas de 'other' no cuentan");
}

console.log("\n# parseSubmissions con filtro de formularios");
{
  const json = {
    filings: {
      recent: {
        form: ["4", "8-K", "SC 13G/A", "4", "10-Q"],
        filingDate: ["2026-09-01", "2026-09-01", "2026-08-30", "2026-07-01", "2026-08-15"],
        accessionNumber: ["0001-26-1", "0001-26-2", "0001-26-3", "0001-26-4", "0001-26-5"],
        primaryDocument: ["xslF345X05/a.xml", "b.htm", "c.htm", "xslF345X05/d.xml", "e.htm"],
        primaryDocDescription: ["", "", "", "", ""],
        items: ["", "2.02", "", "", ""],
      },
    },
  };
  const since = NOW - 45 * DAY;
  eq(parseSubmissions(json, "0000001045810", since, (f) => f === "4").map((f) => f.accession), ["0001-26-1"], "solo Form 4 recientes");
  eq(parseSubmissions(json, "0000001045810", since).map((f) => f.form), ["8-K", "SC 13G/A", "10-Q"], "por defecto, los formularios de FORM_IMPACT (13G/A incluido)");
  eq(classifyFiling("SC 13D", []).label, "Participacion >5% con intencion de influir (SC 13D, activista)", "etiqueta 13D");
  eq([classifyFiling("SC 13G", []).skip, classifyFiling("SC 13G/A", []).impact], [false, "medium"], "13G entra; 13G/A impacto medio");
}

console.log("\n# Google News RSS");
{
  const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
  <item><title>Nvidia beats estimates again - Reuters</title><link>https://news.google.com/rss/articles/CBMi1</link><pubDate>${new Date(NOW - 1 * DAY).toUTCString()}</pubDate><source url="https://www.reuters.com">Reuters</source></item>
  <item><title>Old story - Bloomberg</title><link>https://news.google.com/rss/articles/CBMi2</link><pubDate>${new Date(NOW - 20 * DAY).toUTCString()}</pubDate><source url="https://www.bloomberg.com">Bloomberg</source></item>
  <item><title>No link</title><pubDate>${new Date(NOW).toUTCString()}</pubDate></item>
  </channel></rss>`;
  const items = parseGoogleNewsRss(rss, "nvda", NOW);
  eq(items.length, 1, "descarta lo viejo y lo sin enlace");
  eq([items[0].headline, items[0].source, items[0].tickers], ["Nvidia beats estimates again", "Reuters", ["NVDA"]], "titular limpio, medio y ticker");
  eq(parseGoogleNewsRss("garbage", "X"), [], "xml invalido → vacio");
  eq(googleNewsQuery({ symbol: "KVYO", name: "Klaviyo" }), 'KVYO stock OR "Klaviyo"', "consulta con nombre");
  eq(googleNewsQuery({ symbol: "AAPL", name: "AAPL" }), "AAPL stock", "sin nombre distinto, solo simbolo");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
