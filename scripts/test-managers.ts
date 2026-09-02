/**
 * Test del modulo de inversores (13F), sin red:
 *  - parseo de la tabla de posiciones (con y sin namespace), agregacion,
 *    submissions de EDGAR, diff trimestre a trimestre, textos y materialidad,
 *    respuesta de OpenFIGI;
 *  - integracion contra SQLite local con EDGAR y OpenFIGI SUSTITUIDOS por
 *    funciones inyectadas: alta, sync, eventos solo para lo que sigues,
 *    idempotencia, pausa, deadline, tope de posiciones, borrado.
 * Correr con: npm run test:managers
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `managers-test-${process.pid}.db`);
function wipe() {
  for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* no existia */
    }
  }
}
wipe();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.AUTH_SECRET ||= "test-secret";
process.env.AUTH_PASSWORD_HASH ||= "x";
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.OPENROUTER_API_KEY ||= "test";
process.env.FINNHUB_API_KEY = "";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { assets, events, eventSources, managerFilings, managerHoldings, managers, news, watchlist } from "../src/db/schema";
import {
  addManager,
  aggregateHoldings,
  describeChange,
  diffHoldings,
  isInfoTableXml,
  listManagers,
  MANAGER_LIMITS,
  materialityFor,
  padCik,
  parseInfoTable,
  parseManagerSubmissions,
  parseOpenFigi,
  quarterLabel,
  removeManager,
  searchManagers,
  setManagerEnabled,
  syncManagers,
  type Holding,
  type ManagerChange,
  type ManagerDeps,
} from "../src/lib/managers";

let failures = 0;
let checks = 0;

function eq_<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function truthy_(v: unknown, label: string) {
  checks++;
  if (!v) {
    failures++;
    console.error(`  FALLO ${label}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

async function throws(fn: () => Promise<unknown>, needle: string, label: string) {
  checks++;
  try {
    await fn();
    failures++;
    console.error(`  FALLO ${label}: no lanzo`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(needle)) console.log(`  ok  ${label}`);
    else {
      failures++;
      console.error(`  FALLO ${label}: mensaje "${msg}" no contiene "${needle}"`);
    }
  }
}

async function migrate() {
  const client = createClient({ url: `file:${dbFile}` });
  const dir = path.join(__dirname, "..", "drizzle");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.execute(s);
    }
  }
  client.close();
  return files.length;
}

// ---------------------------------------------------------------------------
// Fixtures

const CUSIP = { AAPL: "037833100", KO: "191216100", BAC: "060505104", MSFT: "594918104" } as const;
const NAMES: Record<string, string> = { AAPL: "APPLE INC", KO: "COCA COLA CO", BAC: "BANK OF AMERICA CORP", MSFT: "MICROSOFT CORP" };

type Row = { sym: keyof typeof CUSIP; shares: number; value: number; putCall?: string; type?: string };

function infoTable(rows: Row[], ns = "ns1"): string {
  const p = ns ? `${ns}:` : "";
  const body = rows
    .map(
      (r) => `
  <${p}infoTable>
    <${p}nameOfIssuer>${NAMES[r.sym]}</${p}nameOfIssuer>
    <${p}titleOfClass>COM</${p}titleOfClass>
    <${p}cusip>${CUSIP[r.sym]}</${p}cusip>
    <${p}value>${r.value}</${p}value>
    <${p}shrsOrPrnAmt>
      <${p}sshPrnamt>${r.shares}</${p}sshPrnamt>
      <${p}sshPrnamtType>${r.type ?? "SH"}</${p}sshPrnamtType>
    </${p}shrsOrPrnAmt>${r.putCall ? `\n    <${p}putCall>${r.putCall}</${p}putCall>` : ""}
    <${p}investmentDiscretion>SOLE</${p}investmentDiscretion>
    <${p}votingAuthority><${p}Sole>${r.shares}</${p}Sole><${p}Shared>0</${p}Shared><${p}None>0</${p}None></${p}votingAuthority>
  </${p}infoTable>`,
    )
    .join("");
  const xmlns = ns ? ` xmlns:${ns}="http://www.sec.gov/edgar/document/thirteenf/informationtable"` : ` xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${p}informationTable${xmlns}>${body}\n</${p}informationTable>`;
}

const PRIMARY_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler"><headerData><submissionType>13F-HR</submissionType></headerData>
<formData><coverPage><reportCalendarOrQuarter>06-30-2026</reportCalendarOrQuarter></coverPage><summaryPage><tableEntryTotal>4</tableEntryTotal></summaryPage></formData></edgarSubmission>`;

type Filing = { acc: string; form: string; filed: string; period: string; rows: Row[] };

function submissions(name: string, filings: Filing[]) {
  return {
    cik: "1067983",
    name,
    filings: {
      recent: {
        accessionNumber: filings.map((f) => f.acc),
        form: filings.map((f) => f.form),
        filingDate: filings.map((f) => f.filed),
        reportDate: filings.map((f) => f.period),
      },
    },
  };
}

/** EDGAR + OpenFIGI falsos, con contadores. */
function fakeDeps(world: Map<string, { name: string; filings: Filing[] }>) {
  const calls = { json: 0, text: 0, figi: 0, figiCusips: [] as string[] };
  const folder = (cik: string, acc: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/`;
  const deps: ManagerDeps = {
    now: () => Date.now(),
    json: async (url) => {
      calls.json++;
      const sub = url.match(/submissions\/CIK(\d{10})\.json$/);
      if (sub) {
        const w = world.get(sub[1]);
        return w ? submissions(w.name, w.filings) : {};
      }
      if (url.endsWith("index.json")) {
        return { directory: { item: [{ name: "primary_doc.xml" }, { name: "infotable.xml" }, { name: "0001067983-26-000001-index.htm" }] } };
      }
      if (url.includes("efts.sec.gov")) {
        return { hits: { hits: [{ _id: "1067983", _source: { entity: "BERKSHIRE HATHAWAY INC (CIK 0001067983)" } }] } };
      }
      throw new Error(`json inesperado: ${url}`);
    },
    text: async (url) => {
      calls.text++;
      for (const [cik, w] of world) {
        for (const f of w.filings) {
          if (url === `${folder(cik, f.acc)}primary_doc.xml`) return PRIMARY_DOC;
          if (url === `${folder(cik, f.acc)}infotable.xml`) return infoTable(f.rows);
        }
      }
      throw new Error(`text inesperado: ${url}`);
    },
    figi: async (cusips) => {
      calls.figi++;
      calls.figiCusips.push(...cusips);
      const out = new Map<string, { ticker: string; name: string } | null>();
      for (const c of cusips) {
        const sym = (Object.keys(CUSIP) as Array<keyof typeof CUSIP>).find((k) => CUSIP[k] === c);
        out.set(c, sym ? { ticker: sym, name: NAMES[sym] } : null);
      }
      return out;
    },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("1. Parseo de la tabla de posiciones");
  const xml = infoTable([
    { sym: "AAPL", shares: 1000, value: 200_000 },
    { sym: "AAPL", shares: 500, value: 100_000 },
    { sym: "KO", shares: 2000, value: 120_000 },
    { sym: "BAC", shares: 100, value: 4_000, putCall: "Put" },
    { sym: "MSFT", shares: 50_000, value: 50_000, type: "PRN" },
  ]);
  truthy_(isInfoTableXml(xml), "detecta la tabla con namespace");
  truthy_(isInfoTableXml(infoTable([{ sym: "KO", shares: 1, value: 1 }], "")), "detecta la tabla sin namespace");
  truthy_(!isInfoTableXml(PRIMARY_DOC), "la caratula no es la tabla");

  const rows = parseInfoTable(xml);
  eq_(rows.length, 5, "5 filas");
  eq_(rows[0], { cusip: "037833100", issuer: "APPLE INC", titleOfClass: "COM", value: 200000, shares: 1000, sshType: "SH", putCall: "" }, "fila normal");
  eq_(rows[3].putCall, "PUT", "putCall en mayusculas");
  eq_(rows[4].sshType, "PRN", "tipo PRN");
  eq_(parseInfoTable(infoTable([{ sym: "KO", shares: 7, value: 9 }], "")).length, 1, "sin namespace tambien");
  eq_(parseInfoTable("<informationTable></informationTable>"), [], "tabla vacia → []");
  eq_(parseInfoTable(PRIMARY_DOC), [], "caratula → []");

  const agg = aggregateHoldings(rows);
  eq_(agg.map((h) => h.cusip), ["037833100", "191216100"], "agrega AAPL, excluye put y PRN, ordena por valor");
  eq_(agg[0].shares, 1500, "suma acciones del mismo CUSIP");
  eq_(agg[0].value, 300_000, "suma valor");
  eq_(Math.round(agg[0].pct * 100) / 100, 71.43, "porcentaje sobre el total restante");
  eq_(Math.round(agg.reduce((a, h) => a + h.pct, 0)), 100, "los % suman 100");
  eq_(aggregateHoldings([]), [], "sin filas → []");

  // -------------------------------------------------------------------------
  console.log("\n2. Submissions de EDGAR");
  const subs = submissions("BERKSHIRE HATHAWAY INC", [
    { acc: "0000950123-26-008001", form: "13F-HR", filed: "2026-08-14", period: "2026-06-30", rows: [] },
    { acc: "0000950123-26-007000", form: "13F-HR/A", filed: "2026-06-01", period: "2026-03-31", rows: [] },
    { acc: "0000950123-26-006000", form: "13F-HR", filed: "2026-05-15", period: "2026-03-31", rows: [] },
    { acc: "0000950123-26-001000", form: "8-K", filed: "2026-02-01", period: "2026-01-31", rows: [] },
    { acc: "0000950123-25-009000", form: "13F-HR", filed: "2025-11-14", period: "", rows: [] },
  ]);
  const parsed = parseManagerSubmissions(subs, "0001067983");
  eq_(parsed.name, "BERKSHIRE HATHAWAY INC", "nombre");
  eq_(parsed.filings.map((f) => f.accession), ["0000950123-26-008001", "0000950123-26-006000"], "solo 13F-HR con periodo, mas reciente primero");
  eq_(parsed.filings[0].url, "https://www.sec.gov/Archives/edgar/data/1067983/000095012326008001/", "URL de la carpeta sin ceros ni guiones");
  eq_(parsed.filings[0].period, "2026-06-30", "periodo del reportDate");
  eq_(new Date(parsed.filings[0].filedAt).toISOString().slice(0, 10), "2026-08-14", "fecha de presentacion");
  eq_(parseManagerSubmissions({}, "0001067983"), { name: "", filings: [] }, "JSON vacio → sin nombre ni filings");
  eq_(padCik("1067983"), "0001067983", "padCik");
  eq_(padCik("CIK 0001067983"), "0001067983", "padCik limpia texto");

  // -------------------------------------------------------------------------
  console.log("\n3. Diff trimestre a trimestre");
  const h = (cusip: string, shares: number, pct: number, ticker: string | null = null): Holding => ({ cusip, issuer: cusip, shares, value: pct * 1000, pct, ticker });
  const prev = [h("A", 100, 40), h("B", 100, 30), h("C", 100, 20), h("D", 100, 9.7), h("E", 100, 0.3)];
  const curr = [h("A", 130, 40), h("B", 70, 30), h("C", 110, 20), h("F", 50, 5), h("G", 10, 0.2), h("H", 100, 4.8)];
  const changes = diffHoldings(prev, curr);
  eq_(
    changes.map((c) => `${c.kind}:${c.cusip}`),
    ["increase:A", "decrease:B", "exit:D", "new:F", "new:H"],
    "entradas/salidas ≥0.5%, variaciones ≥25% en posiciones ≥1%, ordenado por tamano",
  );
  eq_(Math.round(changes[0].deltaPct!), 30, "delta de acciones en %");
  eq_(changes[1].deltaPct, -30, "delta negativo");
  eq_(changes[2].prevShares, 100, "salida conserva acciones previas");
  eq_(changes[3].deltaPct, null, "entrada sin delta");
  eq_(diffHoldings(null, curr), [], "sin trimestre anterior no hay diff");
  eq_(diffHoldings(prev, prev), [], "misma cartera → sin cambios");
  eq_(diffHoldings([h("Z", 0, 1)], [h("Z", 10, 1)]), [], "acciones previas 0 no divide por cero");
  const loose = diffHoldings(prev, curr, { ...MANAGER_LIMITS, changeMinPct: 0, changeThreshold: 0.05, newExitMinPct: 0 });
  eq_(loose.map((c) => `${c.kind}:${c.cusip}`), ["increase:A", "decrease:B", "increase:C", "exit:D", "new:F", "new:H", "exit:E", "new:G"], "limites inyectables");

  // -------------------------------------------------------------------------
  console.log("\n4. Textos, materialidad y OpenFIGI");
  eq_(quarterLabel("2026-06-30"), "Q2 2026", "Q2");
  eq_(quarterLabel("2025-12-31"), "Q4 2025", "Q4");
  eq_(quarterLabel("raro"), "raro", "periodo raro se devuelve tal cual");

  const filing = { period: "2026-06-30", filedAt: Date.UTC(2026, 7, 14, 12), url: "https://www.sec.gov/x/" };
  const mk = (over: Partial<ManagerChange>): ManagerChange => ({
    kind: "new", cusip: "037833100", issuer: "APPLE INC", ticker: "AAPL", shares: 1_000_000, prevShares: 0, deltaPct: null, value: 250_000_000, pct: 2.5, prevPct: 0, ...over,
  });
  const d1 = describeChange("Berkshire Hathaway Inc", mk({}), filing);
  eq_(d1.headline, "Berkshire Hathaway Inc abre posicion en AAPL", "titular de entrada");
  truthy_(d1.fact.startsWith("Segun el 13F-HR del Q2 2026 presentado el 2026-08-14, Berkshire Hathaway Inc nueva posicion de 1,000,000 acciones ($250.0M, 2.5% de su cartera)."), "hecho con cifras del filing");
  truthy_(d1.fact.includes("45 dias de retraso") && d1.fact.includes("no incluyen cortos"), "el hecho lleva la salvedad del 13F");
  const d2 = describeChange("X Capital", mk({ kind: "exit", ticker: null, shares: 0, prevShares: 40_000, value: 0, pct: 0, prevPct: 3.2 }), filing);
  eq_(d2.headline, "X Capital sale por completo de APPLE INC", "salida sin ticker usa el emisor");
  truthy_(d2.fact.includes("era el 3.2% de su cartera (40,000 acciones)"), "hecho de salida");
  const d3 = describeChange("X Capital", mk({ kind: "increase", prevShares: 500_000, deltaPct: 100, prevPct: 1.2 }), filing);
  eq_(d3.headline, "X Capital aumenta AAPL un 100%", "titular de subida");
  const d4 = describeChange("X Capital", mk({ kind: "decrease", prevShares: 2_000_000, deltaPct: -50, prevPct: 5 }), filing);
  eq_(d4.headline, "X Capital reduce AAPL un 50%", "titular de bajada (sin signo)");
  truthy_(d4.fact.includes("pasa de 2,000,000 a 1,000,000 acciones"), "hecho de bajada");

  eq_(materialityFor(mk({ pct: 10 })), 75, "entrada grande topa en 75");
  eq_(materialityFor(mk({ pct: 1 })), 45, "entrada del 1% → 45");
  eq_(materialityFor(mk({ kind: "exit", pct: 0, prevPct: 3 })), 55, "salida usa el % previo");
  eq_(materialityFor(mk({ kind: "increase", pct: 2, prevPct: 1 })), 38, "subida del 2% → 38");
  eq_(materialityFor(mk({ kind: "decrease", pct: 20, prevPct: 30 })), 65, "bajada grande topa en 65");

  const figi = parseOpenFigi(
    ["037833100", "191216100", "000000000"],
    [
      { data: [{ ticker: "AAPL/W", securityType: "Warrant", name: "x" }, { ticker: "aapl", securityType: "Common Stock", name: "Apple Inc" }] },
      { error: "No identifier found." },
      { data: [] },
    ],
  );
  eq_(figi.get("037833100"), { ticker: "AAPL", name: "Apple Inc" }, "prefiere Common Stock y pone mayusculas");
  eq_(figi.get("191216100"), null, "error → null");
  eq_(figi.get("000000000"), null, "sin datos → null");
  eq_(parseOpenFigi(["1"], "basura").get("1"), null, "respuesta no array → null");

  // -------------------------------------------------------------------------
  console.log("\n5. Integracion con SQLite local (EDGAR y OpenFIGI falsos)");
  const applied = await migrate();
  eq_(applied >= 7, true, `${applied} ficheros de migracion aplicados`);
  const now = Date.now();
  await db.insert(assets).values([
    { id: "a-aapl", symbol: "AAPL", name: "Apple", assetClass: "equity", currency: "USD", providerId: "AAPL", createdAt: now },
    { id: "a-msft", symbol: "MSFT", name: "Microsoft", assetClass: "equity", currency: "USD", providerId: "MSFT", createdAt: now },
  ]);
  await db.insert(watchlist).values({ id: "w-msft", assetId: "a-msft", addedAt: now });

  const Q1: Filing = {
    acc: "0000950123-26-006000", form: "13F-HR", filed: "2026-05-15", period: "2026-03-31",
    rows: [
      { sym: "AAPL", shares: 1000, value: 500_000 },
      { sym: "KO", shares: 2000, value: 300_000 },
      { sym: "BAC", shares: 3000, value: 200_000 },
    ],
  };
  const Q2: Filing = {
    acc: "0000950123-26-008001", form: "13F-HR", filed: "2026-08-14", period: "2026-06-30",
    rows: [
      { sym: "AAPL", shares: 700, value: 400_000 },
      { sym: "KO", shares: 2000, value: 300_000 },
      { sym: "MSFT", shares: 400, value: 200_000 },
      { sym: "MSFT", shares: 10, value: 1_000, putCall: "Call" },
    ],
  };
  const world = new Map<string, { name: string; filings: Filing[] }>();
  world.set("0001067983", { name: "BERKSHIRE HATHAWAY INC", filings: [Q2, { ...Q1, acc: "0000950123-26-007000", form: "13F-HR/A" }, Q1] });
  world.set("0000000001", { name: "SOME OPERATING CO", filings: [{ acc: "0000000001-26-000001", form: "8-K", filed: "2026-01-01", period: "2026-01-01", rows: [] }] });
  const { deps, calls } = fakeDeps(world);

  const hits = await searchManagers("berkshire", deps);
  eq_(hits, [{ cik: "0001067983", name: "BERKSHIRE HATHAWAY INC (CIK 0001067983)" }], "busqueda por nombre");
  eq_(await searchManagers("b", deps), [], "busqueda demasiado corta no llama a EDGAR");

  await throws(() => addManager("0", deps), "CIK invalido", "CIK 0 se rechaza");
  await throws(() => addManager("9999999", deps), "EDGAR no devolvio", "CIK desconocido");
  await throws(() => addManager("1", deps), "no presenta 13F-HR", "una empresa sin 13F no se puede seguir");
  const m = await addManager("1067983", deps, "el de Omaha");
  eq_(m.name, "Berkshire Hathaway Inc", "nombre oficial en Title Case");
  eq_(m.cik, "0001067983", "CIK con ceros");
  eq_(m.enabled, true, "activo al crearlo");
  eq_((await addManager("0001067983", deps)).id, m.id, "alta repetida devuelve el mismo gestor");
  eq_((await db.select().from(managers)).length, 1, "un solo gestor en la tabla");

  const before = { json: calls.json, figi: calls.figi };
  const r1 = await syncManagers(deps);
  eq_(r1.length, 1, "una pasada por gestor activo");
  eq_(r1[0].error, undefined, `sin error (${r1[0].error ?? "-"})`);
  eq_({ filings: r1[0].filings, changes: r1[0].changes, events: r1[0].events }, { filings: 2, changes: 3, events: 2 }, "2 filings, 3 cambios, 2 eventos (solo activos seguidos)");
  eq_(calls.figi - before.figi, 2, "una llamada a OpenFIGI por filing");
  eq_([...new Set(calls.figiCusips)].length, calls.figiCusips.length, "la cache de CUSIP evita repetir peticiones");
  eq_(calls.figiCusips.length, 4, "4 CUSIPs resueltos en total");

  const filingsRows = await db.select().from(managerFilings).orderBy(managerFilings.period);
  eq_(filingsRows.map((f) => f.period), ["2026-03-31", "2026-06-30"], "dos filings guardados");
  eq_(filingsRows[0].changes, "[]", "el primero no tiene con que compararse");
  eq_(filingsRows[1].positions, 3, "la opcion call no cuenta como posicion");
  eq_(filingsRows[1].totalValue, 900_000, "valor total sin la opcion");
  const q2changes = JSON.parse(filingsRows[1].changes) as ManagerChange[];
  eq_(q2changes.map((c) => `${c.kind}:${c.ticker}`), ["decrease:AAPL", "new:MSFT", "exit:BAC"], "cambios del Q2 con ticker, por tamano");
  eq_((await db.select().from(managerHoldings)).length, 6, "posiciones guardadas de ambos filings");

  const evs = await db.select().from(events).orderBy(events.headline);
  eq_(evs.map((e) => e.headline), ["Berkshire Hathaway Inc abre posicion en MSFT", "Berkshire Hathaway Inc reduce AAPL un 30%"], "eventos solo para AAPL (conocido) y MSFT (watchlist); BAC no");
  eq_(evs.map((e) => [e.type, e.sourceTier, e.confidence, e.thesisImpact, e.promptVersion, e.model]), [["ownership", 1, 95, 0, "13f-v1", null], ["ownership", 1, 95, 0, "13f-v1", null]], "tier 1, sin IA, sin impacto de tesis");
  truthy_(evs.every((e) => e.priority && e.signalScore > 0), "score y prioridad calculados");
  eq_(evs.map((e) => e.primaryAssetId), ["a-msft", "a-aapl"], "enlazados al activo");
  eq_(evs.map((e) => e.portfolioRelevance), [40, 15], "relevancia: watchlist > conocido");
  const evNews = await db.select().from(news);
  eq_(evNews.length, 1, "una fila de news por filing con eventos");
  eq_([evNews[0].source, evNews[0].kind, evNews[0].url], ["SEC EDGAR", "filing", "https://www.sec.gov/Archives/edgar/data/1067983/000095012326008001/"], "evidencia con la URL de EDGAR");
  eq_(JSON.parse(evNews[0].tickers), ["AAPL", "MSFT"], "tickers de la evidencia");
  eq_((await db.select().from(eventSources)).length, 2, "cada evento enlaza su evidencia");

  const r2 = await syncManagers(deps);
  eq_({ filings: r2[0].filings, changes: r2[0].changes, events: r2[0].events }, { filings: 0, changes: 0, events: 0 }, "segunda pasada: nada nuevo");
  eq_((await db.select().from(events)).length, 2, "sin eventos duplicados");
  eq_((await db.select().from(managerFilings)).length, 2, "sin filings duplicados");

  const views = await listManagers();
  eq_(views.length, 1, "vista de un gestor");
  eq_(views[0].filings, 2, "cuenta de filings");
  eq_(views[0].latest?.period, "2026-06-30", "el ultimo es el Q2");
  eq_(views[0].latest?.changes.map((c) => `${c.ticker ?? c.issuer}:${c.tracked}`), ["AAPL:known", "MSFT:watchlist", "BAC:null"], "etiquetas de seguimiento en los cambios");
  eq_(views[0].top.map((h) => `${h.ticker}:${h.pct.toFixed(1)}`), ["AAPL:44.4", "KO:33.3", "MSFT:22.2"], "top por valor con %");
  eq_(views[0].top[1].tracked, null, "KO no se sigue");
  truthy_(views[0].manager.lastSyncAt && !views[0].manager.lastError, "lastSyncAt sin error");

  console.log("\n6. Pausa, deadline y tope de posiciones");
  await setManagerEnabled(m.id, false);
  eq_(await syncManagers(deps), [], "gestor pausado no se sincroniza");
  await setManagerEnabled(m.id, true);
  const jsonBefore = calls.json;
  const r3 = await syncManagers(deps, { deadline: Date.now() - 1 });
  eq_(r3, [{ manager: "Berkshire Hathaway Inc", filings: 0, changes: 0, events: 0, skipped: true }], "sin tiempo → skipped");
  eq_(calls.json, jsonBefore, "skipped no toca la red");

  const many: Row[] = [];
  for (let i = 0; i < MANAGER_LIMITS.maxHoldings + 1; i++) {
    many.push({ sym: "KO", shares: 1, value: 1 });
  }
  // Cada fila necesita CUSIP distinto para contar como posicion distinta.
  const bigXml = many
    .map((_, i) => `<infoTable><nameOfIssuer>X${i}</nameOfIssuer><cusip>${String(i).padStart(9, "0")}</cusip><value>1</value><shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`)
    .join("");
  const quant = { acc: "0000102909-26-000001", form: "13F-HR", filed: "2026-08-10", period: "2026-06-30", rows: [] as Row[] };
  world.set("0000102909", { name: "VANGUARD GROUP INC", filings: [quant] });
  const textOrig = deps.text;
  deps.text = async (url) => (url.includes("000010290926000001") && url.endsWith("infotable.xml") ? `<informationTable>${bigXml}</informationTable>` : textOrig(url));
  const v = await addManager("102909", deps);
  const r4 = await syncManagers(deps);
  const vr = r4.find((r) => r.manager === v.name)!;
  truthy_(vr.error?.includes("demasiadas"), "mas de maxHoldings posiciones → error claro");
  eq_((await db.select().from(managerFilings).where(eq(managerFilings.managerId, v.id))).length, 0, "no se guarda nada del fondo cuantitativo");
  truthy_((await db.select().from(managers).where(eq(managers.id, v.id)))[0].lastError?.includes("demasiadas"), "el error queda en el gestor");
  eq_(r4.map((r) => r.manager)[0], v.name, "el que nunca se ha sincronizado va primero");

  console.log("\n7. Un trimestre nuevo y borrado");
  const Q3: Filing = {
    acc: "0000950123-26-010000", form: "13F-HR", filed: "2026-11-13", period: "2026-09-30",
    rows: [
      { sym: "AAPL", shares: 700, value: 420_000 },
      { sym: "KO", shares: 3000, value: 450_000 },
      { sym: "MSFT", shares: 400, value: 210_000 },
    ],
  };
  world.get("0001067983")!.filings.unshift(Q3);
  const r5 = await syncManagers(deps);
  const br = r5.find((r) => r.manager === m.name)!;
  eq_({ filings: br.filings, changes: br.changes, events: br.events }, { filings: 1, changes: 1, events: 0 }, "Q3: un filing, KO sube, sin eventos (KO no se sigue)");
  const v2 = (await listManagers()).find((x) => x.manager.id === m.id)!;
  eq_(v2.latest?.period, "2026-09-30", "el ultimo pasa a ser Q3");
  eq_(v2.latest?.changes.map((c) => `${c.kind}:${c.ticker}:${Math.round(c.deltaPct ?? 0)}`), ["increase:KO:50"], "subida del 50% en KO");
  eq_(v2.filings, 3, "tres filings");

  await removeManager(m.id);
  eq_((await db.select().from(managers)).length, 1, "queda solo el otro gestor");
  eq_((await db.select().from(managerFilings)).length, 0, "filings borrados");
  eq_((await db.select().from(managerHoldings)).length, 0, "posiciones borradas");
  eq_((await db.select().from(events)).length, 2, "los eventos ya creados se conservan");
}

main()
  .then(() => {
    console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
    wipe();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("Error inesperado:", e);
    wipe();
    process.exit(1);
  });
