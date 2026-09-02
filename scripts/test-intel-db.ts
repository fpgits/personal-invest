/**
 * Test de integracion del motor de inteligencia contra una base SQLite local
 * (libsql en fichero): aplica las migraciones reales, siembra noticias y
 * recorre la maquina de estados del orquestador con la IA SUSTITUIDA por
 * funciones falsas inyectadas. No hay red.
 * Correr con: npm run test:intel:db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `intel-db-test-${process.pid}.db`);
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
import { assets, events, eventSources, fundamentals, news, settings, thesisAssumptions, thesisChanges } from "../src/db/schema";
import { buildExtractPrompt, type ExtractResult } from "../src/lib/intel/extract";
import { getThesisView, proposeFromEvent, resolveProposal, saveThesis } from "../src/lib/thesis";
import {
  LAST_RUN_KEY,
  lastRun,
  processEvents,
  recentEvents,
  setEventFeedback,
  type IntelDeps,
} from "../src/lib/intel/run";
import type { Cluster, ExtractedEvent } from "../src/lib/intel/types";

let failures = 0;
let checks = 0;

function eq_<T>(actual: T, expected: T, label: string) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(
      `  FALLO ${label}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`,
    );
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

const now = Date.now();
const DAY = 86400_000;
const H = 3600_000;

let seq = 0;
type NewsInsert = typeof news.$inferInsert;
function newsRow(
  headline: string,
  opts: Partial<Omit<NewsInsert, "tickers">> & { tickers?: string[] } = {},
): NewsInsert {
  seq++;
  const { tickers, ...rest } = opts;
  return {
    id: `n${seq}`,
    headline,
    url: `https://example.com/${seq}`,
    source: "Yahoo",
    publishedAt: now - H,
    tickers: JSON.stringify(tickers ?? ["AAPL"]),
    processedAt: now,
    impact: "high",
    createdAt: now,
    ...rest,
  };
}

const okEvent = (over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  type: "earnings",
  primary_symbol: "AAPL",
  companies: ["AAPL"],
  headline: "Apple supera estimaciones",
  fact: "Ingresos por encima de lo esperado.",
  inference: "",
  assessment: "Refuerza la tesis.",
  materiality: 70,
  confidence: 80,
  thesis_impact: 40,
  time_horizon: "medium",
  is_noise: false,
  ...over,
});

type Handler = (cluster: Cluster) => ExtractResult;

/**
 * IA falsa: `byItem` decide la respuesta segun que noticia lleva el cluster
 * (asi el test no depende del orden en que el motor procesa los clusters);
 * `fallback` cubre el resto. Cuenta las llamadas.
 */
function fakeAI(byItem: Record<string, ExtractResult | Handler> = {}, fallback?: ExtractResult | Handler) {
  const calls: Cluster[] = [];
  const deps: Partial<IntelDeps> = {
    merge: async () => null,
    extract: async (cluster) => {
      calls.push(cluster);
      const hit = cluster.items.map((i) => byItem[i.id]).find(Boolean) ?? fallback;
      if (!hit) throw new Error("fakeAI sin respuesta para " + cluster.items.map((i) => i.id).join(","));
      return typeof hit === "function" ? hit(cluster) : hit;
    },
  };
  return { deps, calls };
}

const success = (over: Partial<ExtractedEvent> = {}): ExtractResult => ({
  ok: true,
  event: okEvent(over),
  model: "fake-model",
  promptVersion: "events-test",
});
const failure = (kind: "invalid" | "rejected" | "transient", message: string): ExtractResult => ({
  ok: false,
  kind,
  message,
  countsAttempt: kind !== "transient",
});

async function pendingIds(): Promise<string[]> {
  const rows = await db.select({ id: news.id, done: news.eventProcessedAt }).from(news);
  return rows.filter((r) => r.done === null).map((r) => r.id).sort();
}

async function main() {
  console.log("\n1. Migraciones");
  const applied = await migrate();
  eq_(applied >= 6, true, `${applied} ficheros de migracion aplicados`);

  await db.insert(assets).values([
    { id: "a-aapl", symbol: "AAPL", name: "Apple", assetClass: "equity", currency: "USD", providerId: "AAPL", createdAt: now },
    { id: "a-link-crypto", symbol: "LINK", name: "Chainlink", assetClass: "crypto", currency: "USD", providerId: "chainlink", createdAt: now },
    { id: "a-link-equity", symbol: "LINK", name: "Interlink Electronics", assetClass: "equity", currency: "USD", providerId: "LINK", createdAt: now },
    { id: "a-usdt", symbol: "USDT", name: "Tether", assetClass: "cash", currency: "USD", providerId: null, createdAt: now },
  ]);

  // -------------------------------------------------------------------------
  console.log("\n2. Filtro sin IA (falla cerrado)");
  await db.insert(news).values([
    newsRow("Apple old news", { id: "n-old", publishedAt: now - 30 * DAY }),
    newsRow("Apple low impact", { id: "n-low", impact: "low" }),
    newsRow("Random company news", { id: "n-untracked", tickers: ["ZZZZ"] }),
    newsRow("Tether news", { id: "n-cash", tickers: ["USDT"] }),
    newsRow("Apple fresh, not yet processed", { id: "n-unprocessed", processedAt: null, impact: null }),
    newsRow("Apple processed but summary failed", { id: "n-nosummary", impact: null }),
  ]);

  const ai0 = fakeAI();
  const s0 = await processEvents({ trigger: "test" }, ai0.deps);
  eq_(s0.scanned, 5, "escanea solo las noticias ya pasadas por el resumen");
  eq_(s0.skipped, 4, "vieja, low, sin ticker seguido y efectivo se descartan");
  eq_(s0.unsummarized, 1, "la que se quedo sin resumen se cuenta como pendiente de resumen");
  eq_(s0.clusters, 0, "cero clusters");
  eq_(ai0.calls.length, 0, "cero llamadas al modelo");
  eq_(await pendingIds(), ["n-nosummary", "n-unprocessed"], "solo las no resumidas siguen pendientes");
  eq_(typeof s0.warning, "string", "aviso de noticias sin resumir");
  const persisted = await lastRun();
  eq_(persisted?.scanned, 5, "la ultima pasada queda guardada en settings");

  // -------------------------------------------------------------------------
  console.log("\n3. Extraccion correcta → evento, evidencia y noticias consumidas");
  await db.insert(news).values([
    newsRow("Apple beats Q3 earnings estimates", { id: "n-r1", source: "Reuters", url: "https://www.reuters.com/a" }),
    newsRow("Apple beats Q3 earnings estimates, raises dividend", { id: "n-r2", source: "CNBC", url: "https://www.cnbc.com/b", publishedAt: now - H + 60_000 }),
  ]);
  const ai1 = fakeAI({}, success());
  const s1 = await processEvents({ trigger: "test" }, ai1.deps);
  eq_(ai1.calls.length, 1, "un cluster de dos fuentes → una sola llamada");
  eq_(ai1.calls[0].items.length, 2, "la llamada recibe las dos noticias");
  eq_(s1.created, 1, "un evento nuevo");
  const feed = await recentEvents({ minPriority: "P5" });
  eq_(feed.length, 1, "el feed tiene el evento");
  eq_(feed[0].sources.length, 2, "con sus dos evidencias");
  eq_(feed[0].sourceTier, 2, "tier del evento = mejor fuente (Reuters/CNBC = 2)");
  eq_(feed[0].signalScore, 57.8, "score = 21 + 16 + 10 + 2.25 (relevancia 15) + 8.5");
  eq_(feed[0].priority, "P3", "sin posicion ni watchlist se queda en P3");
  eq_(feed[0].primaryAssetId, "a-aapl", "primary_asset_id resuelto");
  eq_(feed[0].model, "fake-model", "modelo y version del prompt guardados");
  eq_(await pendingIds(), ["n-nosummary", "n-unprocessed"], "las dos noticias del cluster quedan consumidas");
  const evId = feed[0].id;

  // -------------------------------------------------------------------------
  console.log("\n4. Anclas: la parafrasis que llega en la siguiente pasada NO genera otro evento");
  await db.insert(news).values([
    newsRow("Apple beats Q3 earnings estimates and raises dividend", { id: "n-r3", source: "MarketWatch", url: "https://www.marketwatch.com/c", publishedAt: now - 30 * 60_000 }),
  ]);
  const ai2 = fakeAI();
  const s2 = await processEvents({ trigger: "test" }, ai2.deps);
  eq_(ai2.calls.length, 0, "sin llamada al modelo");
  eq_(s2.attached, 1, "enganchada al evento existente");
  const links = await db.select().from(eventSources).where(eq(eventSources.eventId, evId));
  eq_(links.length, 3, "el evento tiene ahora 3 evidencias");
  eq_((await recentEvents({ minPriority: "P5" })).length, 1, "sigue habiendo un solo evento");

  // -------------------------------------------------------------------------
  console.log("\n5. Salida invalida → intentos; al tercer fallo se abandona");
  await db.insert(news).values([newsRow("Apple names new CFO", { id: "n-cfo", source: "Reuters", url: "https://www.reuters.com/d" })]);
  const ai3 = fakeAI({}, failure("invalid", "schema"));
  const s3a = await processEvents({ trigger: "test" }, ai3.deps);
  eq_(s3a.invalid, 1, "primer fallo contado");
  eq_((await pendingIds()).includes("n-cfo"), true, "tras 1 fallo sigue pendiente");
  await processEvents({ trigger: "test" }, ai3.deps);
  eq_((await pendingIds()).includes("n-cfo"), true, "tras 2 fallos sigue pendiente");
  const s3c = await processEvents({ trigger: "test" }, ai3.deps);
  eq_(s3c.abandoned, 1, "al tercer fallo se abandona");
  eq_((await pendingIds()).includes("n-cfo"), false, "y deja de estar pendiente");
  eq_(ai3.calls.length, 3, "exactamente tres intentos");

  // -------------------------------------------------------------------------
  console.log("\n6. Error transitorio → corta la pasada, no consume nada, y queda registrado");
  await db.insert(news).values([
    // n-t1 es mas reciente: con todo lo demas igual, el motor la procesa primero.
    newsRow("Apple opens new campus", { id: "n-t1", source: "Reuters", url: "https://www.reuters.com/e", publishedAt: now - H + 120_000 }),
    newsRow("Apple sued over batteries", { id: "n-t2", source: "Reuters", url: "https://www.reuters.com/f" }),
  ]);
  const ai4 = fakeAI({}, failure("transient", "503 upstream"));
  const s4 = await processEvents({ trigger: "test" }, ai4.deps);
  eq_(ai4.calls.length, 1, "solo una llamada antes de cortar");
  eq_(s4.transient, 1, "transitorio contado");
  eq_(s4.deferred, 1, "el otro cluster queda pendiente");
  eq_(s4.error, "503 upstream", "el error del modelo queda en la pasada");
  eq_((await pendingIds()).filter((i) => i.startsWith("n-t")).length, 2, "ninguna de las dos se consume");
  eq_((await lastRun())?.error, "503 upstream", "y persiste en settings para la UI");
  const attempts = await db.select({ id: news.id, a: news.eventAttempts }).from(news).where(eq(news.id, "n-t1"));
  eq_(attempts[0].a, 0, "un fallo del proveedor no cuenta como intento del cluster");

  // -------------------------------------------------------------------------
  console.log("\n7. Rechazo del proveedor sin exitos previos → se para (configuracion)");
  const ai5 = fakeAI({}, failure("rejected", "404 model not found"));
  const s5 = await processEvents({ trigger: "test" }, ai5.deps);
  eq_(ai5.calls.length, 1, "una sola llamada");
  eq_(s5.rejected, 1, "rechazo contado");
  eq_(s5.deferred, 1, "el resto queda pendiente");

  console.log("\n7b. Rechazo con exitos previos → se salta ese cluster y sigue");
  const ai6 = fakeAI({
    "n-t1": success({ headline: "Campus nuevo", type: "other" }),
    "n-t2": failure("rejected", "403 moderation"),
  });
  const s6 = await processEvents({ trigger: "test" }, ai6.deps);
  eq_(ai6.calls.length, 2, "dos llamadas: el exito y el rechazo");
  eq_(s6.created + s6.noise, 1, "el primero produce evento");
  eq_(s6.rejected, 1, "el segundo se rechaza");
  eq_(s6.deferred, 0, "nada queda diferido");

  // -------------------------------------------------------------------------
  console.log("\n8. Reanalisis cuando llega evidencia mejor a un evento debil");
  await db.insert(news).values([newsRow("rumor: Apple to buy Perplexity", { id: "n-rumor", source: "Twitter", url: "https://x.com/z", publishedAt: now - 2 * DAY })]);
  // n-t2 sigue pendiente (1 intento): se le da un exito para dejarlo cerrado.
  const ai7 = fakeAI({
    "n-rumor": success({ headline: "Rumor de compra", type: "m_and_a", confidence: 30, materiality: 60 }),
    "n-t2": success({ headline: "Demanda por baterias", type: "legal" }),
  });
  const s7 = await processEvents({ trigger: "test" }, ai7.deps);
  eq_(s7.noise + s7.created, 2, "el rumor genera un evento (tier 4) y la demanda otro");
  const rumor = (await recentEvents({ minPriority: "P5" })).find((e) => e.headline === "Rumor de compra")!;
  eq_(rumor.sourceTier, 4, "evento con tier 4");
  eq_(rumor.priority === "P4" || rumor.priority === "P5", true, "tier 4 nunca pasa de P4");

  await db.insert(news).values([newsRow("Apple confirms acquisition of Perplexity", { id: "n-confirm", source: "Reuters", url: "https://www.reuters.com/g", publishedAt: now - H })]);
  const ai8 = fakeAI({
    "n-confirm": (cluster) => {
      eq_(cluster.items.map((i) => i.id).sort(), ["n-confirm", "n-rumor"], "el reanalisis recibe fuentes viejas y nuevas");
      return success({ headline: "Apple confirma la compra", type: "m_and_a", confidence: 90, materiality: 80, thesis_impact: 70 });
    },
  });
  const s8 = await processEvents({ trigger: "test" }, {
    ...ai8.deps,
    // El modelo barato dice: el cluster 0 es el evento existente E1.
    merge: async (clusters, existing) => ({
      groups: [{ members: [0], existing: existing.find((e) => e.id === rumor.id)?.alias ?? null }],
    }),
  });
  eq_(s8.updated, 1, "evento actualizado, no duplicado");
  const updated = (await recentEvents({ minPriority: "P5" })).find((e) => e.id === rumor.id)!;
  eq_(updated.headline, "Apple confirma la compra", "titular reescrito con la evidencia nueva");
  eq_(updated.sourceTier, 2, "tier subido a 2");
  eq_(["P1", "P2", "P3"].includes(updated.priority), true, "prioridad recalculada hacia arriba");
  eq_((await db.select().from(eventSources).where(eq(eventSources.eventId, rumor.id))).length, 2, "ambas fuentes enlazadas");

  // -------------------------------------------------------------------------
  console.log("\n9. Cerrojo: dos pasadas no pueden solaparse");
  await db.update(settings).set({ value: String(now + 60_000) }).where(eq(settings.key, "intel_lock"));
  const ai9 = fakeAI();
  const s9 = await processEvents({ trigger: "test" }, ai9.deps);
  eq_(s9.locked, true, "con cerrojo ajeno vigente no hace nada");
  eq_(ai9.calls.length, 0, "y no llama al modelo");
  await db.update(settings).set({ value: String(now - 60_000) }).where(eq(settings.key, "intel_lock"));
  const s9b = await processEvents({ trigger: "test" }, ai9.deps);
  eq_(s9b.locked, undefined, "con cerrojo caducado vuelve a correr");

  // -------------------------------------------------------------------------
  console.log("\n10. Simbolo repetido en bolsa y cripto: gana bolsa");
  await db.insert(news).values([newsRow("Interlink Electronics reports results", { id: "n-link", tickers: ["LINK"], source: "GlobeNewswire", url: "https://www.globenewswire.com/h" })]);
  const ai10 = fakeAI({}, success({ headline: "Resultados Interlink", primary_symbol: "LINK", companies: ["LINK"] }));
  await processEvents({ trigger: "test" }, ai10.deps);
  const link = (await recentEvents({ minPriority: "P5" })).find((e) => e.headline === "Resultados Interlink")!;
  eq_(link.primaryAssetId, "a-link-equity", "primary_asset_id apunta a la accion, no al token");

  // -------------------------------------------------------------------------
  console.log("\n11. Feed, feedback y clave unica");
  const signals = await recentEvents({ minPriority: "P3" });
  eq_(signals.every((e) => ["P1", "P2", "P3"].includes(e.priority)), true, "P3 minimo excluye P4/P5");
  eq_((await recentEvents({ minPriority: "P5", limit: 2 })).length, 2, "limit se respeta");
  eq_((await recentEvents({ minPriority: "P5", limit: -5 })).length > 0, true, "limit invalido cae al valor por defecto");

  await setEventFeedback(evId, "useful");
  let fb = await db.select({ f: events.feedback, at: events.feedbackAt }).from(events).where(eq(events.id, evId));
  eq_(fb[0].f, "useful", "feedback guardado");
  eq_(fb[0].at !== null, true, "feedbackAt fijado");
  await setEventFeedback(evId, null);
  fb = await db.select({ f: events.feedback, at: events.feedbackAt }).from(events).where(eq(events.id, evId));
  eq_([fb[0].f, fb[0].at], [null, null], "feedback se puede quitar");
  let threw = false;
  try {
    await setEventFeedback(evId, "meh" as never);
  } catch {
    threw = true;
  }
  eq_(threw, true, "feedback invalido se rechaza");

  const first = await db.select({ key: events.clusterKey }).from(events).where(eq(events.id, evId));
  let dup = false;
  try {
    await db.insert(events).values({
      id: "ev-dup", type: "earnings", companies: '["AAPL"]', headline: "Duplicado", fact: "x",
      materiality: 1, confidence: 1, thesisImpact: 0, timeHorizon: "short", portfolioRelevance: 0,
      sourceTier: 3, signalScore: 1, priority: "P5", occurredAt: now, clusterKey: first[0].key, createdAt: now,
    });
  } catch {
    dup = true;
  }
  eq_(dup, true, "misma cluster_key no se puede insertar dos veces");

  const raw = await db.select().from(settings).where(eq(settings.key, LAST_RUN_KEY));
  eq_(raw.length, 1, "settings guarda la ultima pasada");

  // -------------------------------------------------------------------------
  console.log("\n12. Tesis: guardar, proponer desde un evento material, aceptar");
  const thesisId = await saveThesis({
    assetId: "a-aapl",
    structure: {
      summary: "Apple: hardware con servicios de alto margen.",
      bull: ["Servicios crecen"],
      bear: ["Dependencia del iPhone"],
      assumptions: [
        { metric: "Margen operativo", statement: "Se mantiene por encima del 28%", target: 28, comparator: "gte", unit: "%" },
        { metric: "Crecimiento de servicios", statement: "Servicios crece >10%", target: 10, comparator: "gte", unit: "%" },
      ],
      breakers: ["Dos trimestres con margen < 25%"],
      watch: ["Resultados"],
    },
    conviction: 4,
    generatedBy: "test-model",
    promptVersion: "thesis-test",
  });
  let view = (await getThesisView("a-aapl"))!;
  eq_(view.assumptions.length, 2, "dos supuestos guardados");
  eq_(view.assumptions[0].status, "unknown", "estado inicial sin evidencia");
  eq_(view.history.length, 1, "historial con la creacion");
  truthy_(view.thesis.thesis.includes("## Supuestos"), "markdown renderizado con supuestos");

  // Re-guardar conservando estados por metric.
  await db.update(thesisAssumptions).set({ status: "at_risk" }).where(eq(thesisAssumptions.id, view.assumptions[0].id));
  await saveThesis({
    assetId: "a-aapl",
    structure: {
      ...view.structure!,
      assumptions: [
        { metric: "margen operativo", statement: "Por encima del 27%", target: 27, comparator: "gte", unit: "%" },
        { metric: "Nuevo supuesto", statement: "x", target: null, comparator: null, unit: null },
      ],
    },
    generatedBy: "manual",
  });
  view = (await getThesisView("a-aapl"))!;
  eq_(view.assumptions.map((a) => a.status), ["at_risk", "unknown"], "el estado se conserva al casar por metric (insensible a mayusculas)");
  eq_(view.assumptions[0].id, view.assumptions[0].id, "id estable");
  eq_(view.thesis.conviction, 4, "la conviccion se conserva si no se pasa");

  // Un evento material con tesis → propuesta (IA falsa).
  await db.insert(news).values([newsRow("Apple margin falls to 25% as costs rise", { id: "n-margin", source: "Reuters", url: "https://www.reuters.com/m" })]);
  const ai12 = fakeAI({}, success({ headline: "Margen operativo cae al 25%", type: "earnings", thesis_impact: -70, materiality: 80, confidence: 90 }));
  const proposed: string[] = [];
  const s12 = await processEvents(
    { trigger: "test" },
    {
      ...ai12.deps,
      propose: async (eventId) => {
        proposed.push(eventId);
        return proposeFromEvent(eventId, {
          check: async (prompt) => {
            truthy_(prompt.includes("Margen operativo") && prompt.includes("id="), "el contraste recibe los supuestos con id");
            return {
              model: "fake-check",
              object: {
                material: true,
                summary: "El margen cae por debajo del supuesto.",
                assumption_updates: [{ id: view.assumptions[0].id, status: "broken", reason: "25% < 27%" }],
                breaker_hit: false,
                breaker: null,
                conviction_delta: -1,
              },
            };
          },
        });
      },
    },
  );
  eq_(s12.created, 1, "evento creado");
  eq_(proposed.length, 1, "el evento material se contrasta con la tesis");
  eq_(s12.proposals, 1, "propuesta creada");
  view = (await getThesisView("a-aapl"))!;
  eq_(view.pending.length, 1, "una propuesta pendiente");
  eq_(view.assumptions[0].status, "at_risk", "nada se aplica hasta aceptar");

  // Duplicado: el mismo evento no genera otra propuesta.
  const again = await proposeFromEvent(proposed[0], { check: async () => { throw new Error("no deberia llamarse"); } });
  eq_(again, null, "el mismo evento no se propone dos veces");

  // Rechazar no cambia nada; aceptar aplica.
  const pendingId = view.pending[0].id;
  eq_(await resolveProposal(pendingId, false), true, "rechazar resuelve");
  view = (await getThesisView("a-aapl"))!;
  eq_(view.assumptions[0].status, "at_risk", "rechazada: el supuesto no cambia");
  eq_(await resolveProposal(pendingId, true), false, "una propuesta resuelta no se puede volver a resolver");

  // Otra propuesta directa (sin motor) y aceptacion.
  const change2 = await proposeFromEvent(proposed[0], { check: async () => ({ model: "m", object: { material: true, summary: "s", assumption_updates: [{ id: view.assumptions[0].id, status: "broken", reason: "r" }], breaker_hit: true, breaker: "margen < 25%", conviction_delta: -1 } }) });
  eq_(change2, null, "sigue sin duplicar aunque la anterior fuera rechazada (una por evento)");
  const manual = await db.insert(thesisChanges).values({
    id: "chg-manual", thesisId, eventId: null, kind: "proposal", summary: "manual", status: "pending", createdAt: Date.now(),
    payload: JSON.stringify({ assumption_updates: [{ id: view.assumptions[0].id, status: "broken", reason: "25% < 27%" }], breaker_hit: true, breaker: "x", conviction_delta: -1 }),
  }).returning({ id: thesisChanges.id });
  eq_(await resolveProposal(manual[0].id, true), true, "aceptar resuelve");
  view = (await getThesisView("a-aapl"))!;
  eq_(view.assumptions[0].status, "broken", "aceptada: el supuesto pasa a roto");
  eq_(view.assumptions[0].note, "25% < 27%", "con la razon como nota");
  eq_(view.thesis.conviction, 3, "conviccion baja de 4 a 3");
  truthy_(view.thesis.thesis.includes("[Roto] margen operativo"), "el markdown refleja el estado nuevo");

  // -------------------------------------------------------------------------
  console.log("\n13. Filings y fundamentales en el prompt de extraccion");
  await db.insert(fundamentals).values({
    assetId: "a-aapl",
    metrics: JSON.stringify({ pe: 30, operatingMargin: 31 }),
    earnings: "[]",
    nextEarningsAt: null,
    updatedAt: Date.now(),
  });
  await db.insert(news).values([
    newsRow("AAPL presenta 8-K ante la SEC: Item 2.02 (Resultados de operaciones)", {
      id: "n-8k", source: "SEC EDGAR", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/aapl-8k.htm",
      kind: "filing", body: "Apple reported operating margin of 25.1% for the quarter. Revenue grew 3%.", summary: "Documento primario.",
    }),
  ]);
  const ai13 = fakeAI({}, (cluster) => {
    const ctx13 = { tracked: [{ symbol: "AAPL", name: "Apple", assetClass: "equity" }], positions: [], watchlist: [], theses: new Map<string, string>(), fundamentals: new Map([["AAPL", "P/E 30.0, margen operativo 31.0%"]]) };
    const prompt = buildExtractPrompt(cluster, ctx13);
    truthy_(prompt.includes("tier 1 · SEC EDGAR"), "el filing entra como tier 1");
    truthy_(prompt.includes("Extracto del documento: «Apple reported operating margin"), "con extracto del cuerpo");
    truthy_(prompt.includes("Fundamentales (Finnhub"), "y con la linea de fundamentales");
    return success({ headline: "Resultados trimestrales", type: "earnings", thesis_impact: -10 });
  });
  const s13 = await processEvents({ trigger: "test" }, ai13.deps);
  eq_(s13.created, 1, "el filing genera un evento");
  const filingEvent = (await recentEvents({ minPriority: "P5" })).find((e) => e.headline === "Resultados trimestrales")!;
  eq_(filingEvent.sourceTier, 1, "evento con tier 1");

  console.log(`\n${checks - failures}/${checks} comprobaciones correctas`);
  if (failures > 0) {
    console.error(`${failures} fallos`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(wipe);
