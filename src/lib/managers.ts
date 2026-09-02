import { XMLParser } from "fast-xml-parser";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  assets,
  cusipMap,
  events,
  eventSources,
  managerFilings,
  managerHoldings,
  managers,
  news,
  watchlist,
  type Manager,
  type ManagerFiling,
} from "@/db/schema";
import { env } from "./env";
import { loadWeights } from "./intel/calibration";
import { portfolioRelevance, scoreSignal } from "./intel/score";
import { computePortfolio } from "./portfolio";
import { id } from "./utils";

/**
 * Inversores que sigues por sus 13F. Un gestor con mas de $100M en acciones
 * de EE. UU. tiene que publicar su cartera cada trimestre (hasta 45 dias
 * despues del cierre). Aqui se leen esos 13F-HR de EDGAR, se comparan con el
 * trimestre anterior y se sacan los cambios: entradas, salidas y variaciones
 * grandes. Son IDEAS con firma y fecha, no ordenes: nada se copia.
 *
 * Solo lo que toca a un activo que ya sigues entra como evento en Alertas
 * (tier 1, sin IA). El resto se ve en la pagina de Inversores.
 */

export const MANAGER_LIMITS = {
  /** Un gestor con mas posiciones que esto es un fondo cuantitativo: no interesa. */
  maxHoldings: 600,
  /** Entradas y salidas se reportan a partir de este % de la cartera. */
  newExitMinPct: 0.5,
  /** Subidas y bajadas: posicion de al menos este % ... */
  changeMinPct: 1.0,
  /** ... y variacion de acciones de al menos esta fraccion. */
  changeThreshold: 0.25,
  topN: 10,
  /** 13F nuevos por gestor y pasada (el primero trae dos para tener un diff). */
  filingsPerSync: 2,
  /** CUSIPs resueltos con OpenFIGI por pasada. */
  cusipsPerRun: 100,
  pauseMs: 150,
} as const;

export const MANAGER_PROMPT_VERSION = "13f-v1";

export type Holding = {
  cusip: string;
  issuer: string;
  shares: number;
  value: number;
  /** % del total. */
  pct: number;
  ticker: string | null;
};

export type ChangeKind = "new" | "exit" | "increase" | "decrease";

export type ManagerChange = {
  kind: ChangeKind;
  cusip: string;
  issuer: string;
  ticker: string | null;
  shares: number;
  prevShares: number;
  /** Variacion de acciones en %, null para entradas y salidas. */
  deltaPct: number | null;
  value: number;
  pct: number;
  prevPct: number;
};

export type SubmissionFiling = {
  accession: string;
  form: string;
  filedAt: number;
  /** YYYY-MM-DD */
  period: string;
  url: string;
};

// ---------------------------------------------------------------------------
// Parseo (puro)

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function asArray(v: unknown): XmlNode[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as XmlNode[];
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
}

function num(v: unknown): number {
  const n = Number(str(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export type InfoRow = {
  cusip: string;
  issuer: string;
  titleOfClass: string;
  value: number;
  shares: number;
  sshType: string;
  putCall: string;
};

/** Filas de la tabla de un 13F (informationTable). Con o sin prefijo de namespace. */
export function parseInfoTable(xml: string): InfoRow[] {
  const parsed = parser.parse(xml) as XmlNode;
  const table = (parsed.informationTable ?? parsed) as XmlNode;
  const rows = asArray(table.infoTable);
  return rows
    .map((r) => {
      const amt = (r.shrsOrPrnAmt ?? {}) as XmlNode;
      return {
        cusip: str(r.cusip).toUpperCase(),
        issuer: str(r.nameOfIssuer),
        titleOfClass: str(r.titleOfClass),
        value: num(r.value),
        shares: num(amt.sshPrnamt),
        sshType: str(amt.sshPrnamtType).toUpperCase(),
        putCall: str(r.putCall).toUpperCase(),
      };
    })
    .filter((r) => r.cusip.length >= 8);
}

/** Es la tabla de posiciones (y no la caratula primary_doc.xml)? */
export function isInfoTableXml(xml: string): boolean {
  return /<(\w+:)?informationTable[\s>]/i.test(xml);
}

/**
 * Agrega por CUSIP: suma filas del mismo valor (distintos gestores dentro del
 * mismo filer), excluye opciones (putCall) y bonos (PRN). El % es sobre el
 * total de lo que queda.
 */
export function aggregateHoldings(rows: InfoRow[]): Holding[] {
  const byCusip = new Map<string, Holding>();
  for (const r of rows) {
    if (r.putCall) continue;
    if (r.sshType && r.sshType !== "SH") continue;
    const h = byCusip.get(r.cusip) ?? { cusip: r.cusip, issuer: r.issuer, shares: 0, value: 0, pct: 0, ticker: null };
    h.shares += r.shares;
    h.value += r.value;
    if (!h.issuer && r.issuer) h.issuer = r.issuer;
    byCusip.set(r.cusip, h);
  }
  const list = [...byCusip.values()].filter((h) => h.value > 0 || h.shares > 0);
  const total = list.reduce((a, h) => a + h.value, 0);
  for (const h of list) h.pct = total > 0 ? (h.value / total) * 100 : 0;
  return list.sort((a, b) => b.value - a.value);
}

/** 13F-HR recientes del JSON de submissions, mas reciente primero. */
export function parseManagerSubmissions(json: unknown, cik: string): { name: string; filings: SubmissionFiling[] } {
  const root = (json ?? {}) as { name?: string; filings?: { recent?: Record<string, unknown[]> } };
  const recent = root.filings?.recent;
  const name = typeof root.name === "string" ? root.name : "";
  if (!recent) return { name, filings: [] };
  const forms = (recent.form ?? []) as string[];
  const dates = (recent.filingDate ?? []) as string[];
  const reports = (recent.reportDate ?? []) as string[];
  const accs = (recent.accessionNumber ?? []) as string[];
  const cikNum = String(Number(cik));
  const out: SubmissionFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "13F-HR") continue;
    const filedAt = Date.parse(`${dates[i]}T12:00:00Z`);
    if (!Number.isFinite(filedAt) || !accs[i]) continue;
    const period = reports[i] && /^\d{4}-\d{2}-\d{2}$/.test(reports[i]) ? reports[i] : "";
    if (!period) continue;
    const noDashes = accs[i].replace(/-/g, "");
    out.push({
      accession: accs[i],
      form: forms[i],
      filedAt,
      period,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${noDashes}/`,
    });
  }
  return { name, filings: out.sort((a, b) => b.filedAt - a.filedAt) };
}

export type DiffLimits = Pick<typeof MANAGER_LIMITS, "newExitMinPct" | "changeMinPct" | "changeThreshold">;

/** Cambios entre dos 13F consecutivos, ordenados por tamano. */
export function diffHoldings(
  prev: Holding[] | null,
  curr: Holding[],
  L: { [K in keyof DiffLimits]: number } = MANAGER_LIMITS,
): ManagerChange[] {
  if (!prev) return [];
  const before = new Map(prev.map((h) => [h.cusip, h]));
  const after = new Map(curr.map((h) => [h.cusip, h]));
  const out: ManagerChange[] = [];

  for (const h of curr) {
    const p = before.get(h.cusip);
    if (!p) {
      if (h.pct >= L.newExitMinPct) {
        out.push({ kind: "new", cusip: h.cusip, issuer: h.issuer, ticker: h.ticker, shares: h.shares, prevShares: 0, deltaPct: null, value: h.value, pct: h.pct, prevPct: 0 });
      }
      continue;
    }
    if (p.shares <= 0) continue;
    const delta = (h.shares - p.shares) / p.shares;
    const big = Math.max(h.pct, p.pct) >= L.changeMinPct;
    if (big && delta >= L.changeThreshold) {
      out.push({ kind: "increase", cusip: h.cusip, issuer: h.issuer, ticker: h.ticker, shares: h.shares, prevShares: p.shares, deltaPct: delta * 100, value: h.value, pct: h.pct, prevPct: p.pct });
    } else if (big && delta <= -L.changeThreshold) {
      out.push({ kind: "decrease", cusip: h.cusip, issuer: h.issuer, ticker: h.ticker, shares: h.shares, prevShares: p.shares, deltaPct: delta * 100, value: h.value, pct: h.pct, prevPct: p.pct });
    }
  }
  for (const p of prev) {
    if (after.has(p.cusip)) continue;
    if (p.pct >= L.newExitMinPct) {
      out.push({ kind: "exit", cusip: p.cusip, issuer: p.issuer, ticker: p.ticker, shares: 0, prevShares: p.shares, deltaPct: null, value: 0, pct: 0, prevPct: p.pct });
    }
  }
  return out.sort((a, b) => Math.max(b.pct, b.prevPct) - Math.max(a.pct, a.prevPct));
}

export function quarterLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return `Q${Math.ceil(m / 3)} ${y}`;
}

const KIND_LABELS: Record<ChangeKind, string> = {
  new: "abre posicion en",
  exit: "sale por completo de",
  increase: "aumenta",
  decrease: "reduce",
};

export function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Titular y hecho deterministas, con las cifras del filing. Sin IA. */
export function describeChange(
  managerName: string,
  c: ManagerChange,
  filing: { period: string; filedAt: number; url: string },
): { headline: string; fact: string } {
  const label = c.ticker ?? c.issuer;
  const q = quarterLabel(filing.period);
  const filed = new Date(filing.filedAt).toISOString().slice(0, 10);
  let headline: string;
  let detail: string;
  switch (c.kind) {
    case "new":
      headline = `${managerName} ${KIND_LABELS.new} ${label}`;
      detail = `nueva posicion de ${c.shares.toLocaleString("en-US")} acciones (${fmtUsd(c.value)}, ${c.pct.toFixed(1)}% de su cartera)`;
      break;
    case "exit":
      headline = `${managerName} ${KIND_LABELS.exit} ${label}`;
      detail = `vende toda la posicion, que era el ${c.prevPct.toFixed(1)}% de su cartera (${c.prevShares.toLocaleString("en-US")} acciones)`;
      break;
    case "increase":
      headline = `${managerName} ${KIND_LABELS.increase} ${label} un ${Math.round(c.deltaPct ?? 0)}%`;
      detail = `pasa de ${c.prevShares.toLocaleString("en-US")} a ${c.shares.toLocaleString("en-US")} acciones (${fmtUsd(c.value)}, ${c.pct.toFixed(1)}% de su cartera)`;
      break;
    default:
      headline = `${managerName} ${KIND_LABELS.decrease} ${label} un ${Math.abs(Math.round(c.deltaPct ?? 0))}%`;
      detail = `pasa de ${c.prevShares.toLocaleString("en-US")} a ${c.shares.toLocaleString("en-US")} acciones (${fmtUsd(c.value)}, ${c.pct.toFixed(1)}% de su cartera)`;
  }
  const fact = `Segun el 13F-HR del ${q} presentado el ${filed}, ${managerName} ${detail}. Los 13F reflejan posiciones a cierre de trimestre, llegan con hasta 45 dias de retraso y no incluyen cortos ni el motivo de la operacion.`;
  return { headline, fact };
}

/** Materialidad de un cambio: cuanto pesa en la cartera del gestor. */
export function materialityFor(c: ManagerChange): number {
  const size = Math.max(c.pct, c.prevPct);
  if (c.kind === "new" || c.kind === "exit") return Math.round(Math.min(75, 40 + size * 5));
  return Math.round(Math.min(65, 30 + size * 4));
}

export const FIXED_ASSESSMENT =
  "Lo que hace un gestor no es una tesis: es una senal de que alguien con horizonte largo y obligacion de publicar ha decidido algo. Revisa su carta trimestral si la publica, y contrasta con tus propios supuestos.";

/** Respuesta de OpenFIGI (array alineado con la peticion) → cusip → ticker. */
export function parseOpenFigi(
  cusips: string[],
  response: unknown,
): Map<string, { ticker: string; name: string } | null> {
  const out = new Map<string, { ticker: string; name: string } | null>();
  const arr = Array.isArray(response) ? response : [];
  cusips.forEach((cusip, i) => {
    const entry = arr[i] as { data?: Array<{ ticker?: string; name?: string; securityType?: string; exchCode?: string }> } | undefined;
    const data = entry?.data ?? [];
    const pick =
      data.find((d) => d.securityType === "Common Stock" && d.ticker) ??
      data.find((d) => d.ticker) ??
      null;
    out.set(cusip, pick && pick.ticker ? { ticker: pick.ticker.toUpperCase(), name: pick.name ?? "" } : null);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Red (inyectable para tests)

export type ManagerDeps = {
  json: (url: string) => Promise<unknown>;
  text: (url: string) => Promise<string>;
  figi: (cusips: string[]) => Promise<Map<string, { ticker: string; name: string } | null>>;
  now: () => number;
};

function userAgent(): string {
  return `personal-invest/1.0 (${env.secContactEmail || "sin-email-configurado"})`;
}

async function secFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json, application/xml, text/xml, */*" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`SEC respondio ${res.status} en ${url}`);
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function figiLookup(cusips: string[]): Promise<Map<string, { ticker: string; name: string } | null>> {
  const out = new Map<string, { ticker: string; name: string } | null>();
  const key = env.openfigiKey;
  const batch = key ? 100 : 10;
  for (let i = 0; i < cusips.length; i += batch) {
    const part = cusips.slice(i, i + batch);
    const res = await fetch("https://api.openfigi.com/v3/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "X-OPENFIGI-APIKEY": key } : {}) },
      body: JSON.stringify(part.map((c) => ({ idType: "ID_CUSIP", idValue: c, exchCode: "US" }))),
    });
    if (!res.ok) throw new Error(`OpenFIGI respondio ${res.status}`);
    for (const [k, v] of parseOpenFigi(part, await res.json())) out.set(k, v);
    if (i + batch < cusips.length) await sleep(key ? 300 : 3000);
  }
  return out;
}

const defaultDeps: ManagerDeps = {
  json: async (url) => (await secFetch(url)).json(),
  text: async (url) => (await secFetch(url)).text(),
  figi: figiLookup,
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Alta y busqueda

export function padCik(raw: string | number): string {
  return String(raw).replace(/\D/g, "").padStart(10, "0");
}

/** Busca gestores por nombre en el autocompletado de EDGAR. */
export async function searchManagers(
  query: string,
  deps: Partial<ManagerDeps> = {},
): Promise<Array<{ cik: string; name: string }>> {
  const D = { ...defaultDeps, ...deps };
  const q = query.trim();
  if (q.length < 2) return [];
  const json = (await D.json(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`)) as {
    hits?: { hits?: Array<{ _id?: string; _source?: { entity?: string } }> };
  };
  return (json.hits?.hits ?? [])
    .filter((h) => h._id && h._source?.entity)
    .slice(0, 10)
    .map((h) => ({ cik: padCik(h._id!), name: h._source!.entity! }));
}

/** Da de alta un gestor por CIK; valida contra EDGAR y toma el nombre oficial. */
export async function addManager(
  rawCik: string,
  deps: Partial<ManagerDeps> = {},
  note?: string,
): Promise<Manager> {
  const D = { ...defaultDeps, ...deps };
  const cik = padCik(rawCik);
  if (cik === "0000000000") throw new Error("CIK invalido");
  const existing = await db.select().from(managers).where(eq(managers.cik, cik)).limit(1);
  if (existing[0]) return existing[0];

  const json = await D.json(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const { name, filings } = parseManagerSubmissions(json, cik);
  if (!name) throw new Error("EDGAR no devolvio ese CIK");
  if (filings.length === 0) throw new Error(`${name} no presenta 13F-HR: no es un gestor con cartera publica`);

  const row: typeof managers.$inferInsert = {
    id: id(),
    cik,
    name: titleCase(name),
    note: note ?? null,
    enabled: true,
    createdAt: D.now(),
  };
  await db.insert(managers).values(row);
  return (await db.select().from(managers).where(eq(managers.id, row.id)))[0];
}

/** EDGAR devuelve los nombres en mayusculas; se dejan legibles (siglas aparte). */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Llc|Lp|Llp|Plc|Sa|Ag|Nv)\b/g, (m) => m.toUpperCase());
}

// ---------------------------------------------------------------------------
// Sincronizacion

export type ManagerSyncResult = {
  manager: string;
  filings: number;
  changes: number;
  events: number;
  error?: string;
  /** Se quedo sin tiempo antes de tocarlo; entra en la siguiente pasada. */
  skipped?: boolean;
};

export type SyncOptions = {
  /** Epoch ms: pasado este momento no se empiezan mas descargas. */
  deadline?: number;
};

/** Sincroniza los gestores activos, primero los que llevan mas tiempo sin pasada. */
export async function syncManagers(
  deps: Partial<ManagerDeps> = {},
  opts: SyncOptions = {},
): Promise<ManagerSyncResult[]> {
  const D = { ...defaultDeps, ...deps };
  // NULL (nunca sincronizado) va primero en SQLite con ASC.
  const rows = await db.select().from(managers).where(eq(managers.enabled, true)).orderBy(managers.lastSyncAt);
  const out: ManagerSyncResult[] = [];
  for (const m of rows) {
    if (opts.deadline && D.now() > opts.deadline) {
      out.push({ manager: m.name, filings: 0, changes: 0, events: 0, skipped: true });
      continue;
    }
    out.push(await syncManager(m, deps, opts));
  }
  return out;
}

export async function syncManager(
  m: Manager,
  deps: Partial<ManagerDeps> = {},
  opts: SyncOptions = {},
): Promise<ManagerSyncResult> {
  const D = { ...defaultDeps, ...deps };
  const result: ManagerSyncResult = { manager: m.name, filings: 0, changes: 0, events: 0 };
  try {
    const json = await D.json(`https://data.sec.gov/submissions/CIK${m.cik}.json`);
    const { filings } = parseManagerSubmissions(json, m.cik);
    const known = new Set(
      (await db.select({ a: managerFilings.accession }).from(managerFilings).where(eq(managerFilings.managerId, m.id))).map((r) => r.a),
    );
    const todo = filings
      .filter((f) => !known.has(f.accession))
      .slice(0, MANAGER_LIMITS.filingsPerSync)
      .sort((a, b) => a.filedAt - b.filedAt); // del mas viejo al mas nuevo, para que el diff tenga sentido

    for (const f of todo) {
      if (opts.deadline && D.now() > opts.deadline) break; // el siguiente entra en la proxima pasada
      await sleep(MANAGER_LIMITS.pauseMs);
      const holdings = await fetchHoldings(f, D);
      if (holdings === null) continue;
      const stats = await storeFiling(m, f, holdings, D);
      result.filings++;
      result.changes += stats.changes;
      result.events += stats.events;
    }
    await db.update(managers).set({ lastSyncAt: D.now(), lastError: null }).where(eq(managers.id, m.id));
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await db.update(managers).set({ lastSyncAt: D.now(), lastError: result.error }).where(eq(managers.id, m.id));
  }
  return result;
}

/** Descarga los XML del filing y devuelve las posiciones agregadas (o null si no hay tabla). */
async function fetchHoldings(f: SubmissionFiling, D: ManagerDeps): Promise<Holding[] | null> {
  const index = (await D.json(`${f.url}index.json`)) as { directory?: { item?: Array<{ name?: string }> } };
  const xmlFiles = (index.directory?.item ?? []).map((i) => i.name ?? "").filter((n) => /\.xml$/i.test(n));
  for (const name of xmlFiles) {
    await sleep(MANAGER_LIMITS.pauseMs);
    const xml = await D.text(`${f.url}${name}`);
    if (!isInfoTableXml(xml)) continue;
    const rows = parseInfoTable(xml);
    return aggregateHoldings(rows);
  }
  return null;
}

async function storeFiling(
  m: Manager,
  f: SubmissionFiling,
  holdings: Holding[],
  D: ManagerDeps,
): Promise<{ changes: number; events: number }> {
  if (holdings.length > MANAGER_LIMITS.maxHoldings) {
    throw new Error(`${m.name} tiene ${holdings.length} posiciones: demasiadas para seguirlo con sentido`);
  }
  const total = holdings.reduce((a, h) => a + h.value, 0);

  // Filing anterior (por periodo) para el diff.
  const previous = (
    await db
      .select()
      .from(managerFilings)
      .where(eq(managerFilings.managerId, m.id))
      .orderBy(desc(managerFilings.period))
      .limit(1)
  )[0];
  const prevHoldings = previous && previous.period < f.period ? await holdingsOf(previous.id) : null;

  // Tickers: cache + OpenFIGI solo para lo que se va a mostrar.
  const relevant = new Set<string>();
  holdings.slice(0, MANAGER_LIMITS.topN).forEach((h) => relevant.add(h.cusip));
  const rawChanges = diffHoldings(prevHoldings, holdings);
  rawChanges.forEach((c) => relevant.add(c.cusip));
  const tickers = await resolveTickers([...relevant], D);
  for (const h of holdings) h.ticker = tickers.get(h.cusip) ?? null;
  const changes = rawChanges.map((c) => ({ ...c, ticker: tickers.get(c.cusip) ?? null }));

  const filingId = id();
  await db.insert(managerFilings).values({
    id: filingId,
    managerId: m.id,
    accession: f.accession,
    period: f.period,
    filedAt: f.filedAt,
    totalValue: total,
    positions: holdings.length,
    url: f.url,
    changes: JSON.stringify(changes),
    createdAt: D.now(),
  });
  if (holdings.length > 0) {
    for (let i = 0; i < holdings.length; i += 200) {
      await db.insert(managerHoldings).values(
        holdings.slice(i, i + 200).map((h) => ({
          id: id(),
          filingId,
          cusip: h.cusip,
          issuer: h.issuer,
          ticker: h.ticker,
          shares: h.shares,
          value: h.value,
          pct: h.pct,
        })),
      );
    }
  }

  const created = await createEvents(m, f, changes, D);
  return { changes: changes.length, events: created };
}

async function holdingsOf(filingId: string): Promise<Holding[]> {
  const rows = await db.select().from(managerHoldings).where(eq(managerHoldings.filingId, filingId));
  return rows.map((r) => ({ cusip: r.cusip, issuer: r.issuer, shares: r.shares, value: r.value, pct: r.pct, ticker: r.ticker }));
}

async function resolveTickers(cusips: string[], D: ManagerDeps): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (cusips.length === 0) return out;
  const cached = await db.select().from(cusipMap).where(inArray(cusipMap.cusip, cusips));
  for (const c of cached) out.set(c.cusip, c.ticker);
  const missing = cusips.filter((c) => !out.has(c)).slice(0, MANAGER_LIMITS.cusipsPerRun);
  if (missing.length === 0) return out;
  try {
    const resolved = await D.figi(missing);
    for (const c of missing) {
      const hit = resolved.get(c) ?? null;
      out.set(c, hit?.ticker ?? null);
      await db
        .insert(cusipMap)
        .values({ cusip: c, ticker: hit?.ticker ?? null, name: hit?.name ?? null, updatedAt: D.now() })
        .onConflictDoUpdate({
          target: cusipMap.cusip,
          set: { ticker: hit?.ticker ?? null, name: hit?.name ?? null, updatedAt: D.now() },
        });
    }
  } catch (e) {
    // Sin tickers se sigue mostrando el nombre del emisor; no bloquea la pasada.
    console.warn("[managers] OpenFIGI fallo:", e instanceof Error ? e.message : String(e));
    for (const c of missing) if (!out.has(c)) out.set(c, null);
  }
  return out;
}

/**
 * Eventos (tier 1, sin IA) solo para cambios que tocan un activo que sigues.
 * Una fila de `news` por filing sirve de evidencia con la URL de EDGAR.
 */
async function createEvents(
  m: Manager,
  f: SubmissionFiling,
  changes: ManagerChange[],
  D: ManagerDeps,
): Promise<number> {
  const ctx = await trackedContext();
  const hits = changes.filter((c) => c.ticker && ctx.assetIdBySymbol.has(c.ticker));
  if (hits.length === 0) return 0;

  const now = D.now();
  const q = quarterLabel(f.period);
  const newsId = id();
  const inserted = await db
    .insert(news)
    .values({
      id: newsId,
      headline: `${m.name} presenta su 13F-HR del ${q}`,
      url: f.url,
      source: "SEC EDGAR",
      imageUrl: null,
      publishedAt: f.filedAt,
      kind: "filing",
      body: hits.map((c) => describeChange(m.name, c, f).fact).join("\n"),
      summary: `${hits.length} cambio(s) sobre activos que sigues.`,
      sentiment: "neutral",
      impact: "medium",
      tickers: JSON.stringify([...new Set(hits.map((c) => c.ticker!))]),
      processedAt: now,
      eventProcessedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: news.id });
  const sourceId = inserted[0]?.id ?? (await db.select({ id: news.id }).from(news).where(eq(news.url, f.url)).limit(1))[0]?.id;

  const { weights } = await loadWeights().catch(() => ({ weights: undefined, customized: false }));
  let created = 0;
  for (const c of hits) {
    const ticker = c.ticker!;
    const { headline, fact } = describeChange(m.name, c, f);
    const materiality = materialityFor(c);
    const relevance = portfolioRelevance([ticker], ctx.relevance);
    const { score, priority } = scoreSignal(
      {
        materiality,
        confidence: 95,
        thesisImpact: 0,
        portfolioRelevance: relevance,
        sourceTier: 1,
        isNoise: false,
        distinctHosts: 1,
      },
      weights,
    );
    const res = await db
      .insert(events)
      .values({
        id: id(),
        type: "ownership",
        primaryAssetId: ctx.assetIdBySymbol.get(ticker) ?? null,
        companies: JSON.stringify([ticker]),
        headline,
        fact,
        inference: "",
        assessment: FIXED_ASSESSMENT,
        materiality,
        confidence: 95,
        thesisImpact: 0,
        timeHorizon: "long",
        portfolioRelevance: relevance,
        sourceTier: 1,
        signalScore: score,
        priority,
        occurredAt: f.filedAt,
        clusterKey: `13f|${m.cik}|${f.accession}|${c.cusip}`,
        model: null,
        promptVersion: MANAGER_PROMPT_VERSION,
        createdAt: now,
      })
      .onConflictDoNothing({ target: events.clusterKey })
      .returning({ id: events.id });
    if (res[0] && sourceId) {
      await db.insert(eventSources).values({ eventId: res[0].id, newsId: sourceId }).onConflictDoNothing();
      created++;
    }
  }
  return created;
}

type TrackedContext = {
  assetIdBySymbol: Map<string, string>;
  relevance: Parameters<typeof portfolioRelevance>[1];
  positions: Set<string>;
  watch: Set<string>;
};

async function trackedContext(): Promise<TrackedContext> {
  const [all, portfolio, watchRows] = await Promise.all([
    db.select().from(assets),
    computePortfolio({ cacheOnly: true }).catch(() => null),
    db.select({ symbol: assets.symbol }).from(watchlist).innerJoin(assets, eq(watchlist.assetId, assets.id)),
  ]);
  const equities = all.filter((a) => a.assetClass === "equity" || a.assetClass === "etf");
  const assetIdBySymbol = new Map(equities.map((a) => [a.symbol.toUpperCase(), a.id]));
  const positions = (portfolio?.positions ?? [])
    .filter((p) => p.asset.assetClass !== "cash")
    .map((p) => ({ symbol: p.asset.symbol.toUpperCase(), weight: p.weight }));
  const watch = watchRows.map((w) => w.symbol.toUpperCase());
  return {
    assetIdBySymbol,
    relevance: { positions, watchlist: watch, known: [...assetIdBySymbol.keys()] },
    positions: new Set(positions.map((p) => p.symbol)),
    watch: new Set(watch),
  };
}

// ---------------------------------------------------------------------------
// Lectura

export type TrackedTag = "portfolio" | "watchlist" | "known" | null;

export type ManagerView = {
  manager: Manager;
  latest: (Omit<ManagerFiling, "changes"> & { changes: Array<ManagerChange & { tracked: TrackedTag }> }) | null;
  top: Array<Holding & { tracked: TrackedTag }>;
  filings: number;
};

export async function listManagers(): Promise<ManagerView[]> {
  const rows = await db.select().from(managers).orderBy(managers.name);
  if (rows.length === 0) return [];
  const ctx = await trackedContext();
  const tag = (ticker: string | null): TrackedTag => {
    if (!ticker) return null;
    const t = ticker.toUpperCase();
    if (ctx.positions.has(t)) return "portfolio";
    if (ctx.watch.has(t)) return "watchlist";
    if (ctx.assetIdBySymbol.has(t)) return "known";
    return null;
  };

  const out: ManagerView[] = [];
  for (const m of rows) {
    const filings = await db
      .select()
      .from(managerFilings)
      .where(eq(managerFilings.managerId, m.id))
      .orderBy(desc(managerFilings.period));
    const latest = filings[0];
    if (!latest) {
      out.push({ manager: m, latest: null, top: [], filings: 0 });
      continue;
    }
    const holdings = (await holdingsOf(latest.id)).sort((a, b) => b.value - a.value);
    let changes: ManagerChange[] = [];
    try {
      changes = JSON.parse(latest.changes) as ManagerChange[];
    } catch {
      changes = [];
    }
    out.push({
      manager: m,
      latest: { ...latest, changes: changes.map((c) => ({ ...c, tracked: tag(c.ticker) })) },
      top: holdings.slice(0, MANAGER_LIMITS.topN).map((h) => ({ ...h, tracked: tag(h.ticker) })),
      filings: filings.length,
    });
  }
  return out;
}

export async function setManagerEnabled(managerId: string, enabled: boolean): Promise<void> {
  await db.update(managers).set({ enabled }).where(eq(managers.id, managerId));
}

/** Borra gestor, filings y posiciones. Explicito por si el motor no aplica el cascade. */
export async function removeManager(managerId: string): Promise<void> {
  const filingIds = (
    await db.select({ id: managerFilings.id }).from(managerFilings).where(eq(managerFilings.managerId, managerId))
  ).map((r) => r.id);
  if (filingIds.length > 0) {
    await db.delete(managerHoldings).where(inArray(managerHoldings.filingId, filingIds));
    await db.delete(managerFilings).where(eq(managerFilings.managerId, managerId));
  }
  await db.delete(managers).where(eq(managers.id, managerId));
}

export async function managerById(managerId: string): Promise<Manager | null> {
  return (await db.select().from(managers).where(and(eq(managers.id, managerId))).limit(1))[0] ?? null;
}
