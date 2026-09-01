/**
 * Test de integracion del motor de inteligencia contra una base SQLite local
 * (libsql en fichero): aplica las migraciones reales, siembra noticias y
 * comprueba el filtro sin IA, el feed y el feedback. No llama a ningun modelo:
 * las noticias que se siembran se descartan antes de llegar a la IA.
 * Correr con: npm run test:intel:db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `intel-db-test-${process.pid}.db`);
for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
  try {
    fs.rmSync(f);
  } catch {
    /* no existia */
  }
}
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
import { assets, events, eventSources, news } from "../src/db/schema";
import { processEvents, recentEvents, setEventFeedback } from "../src/lib/intel/run";

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

async function main() {
  console.log("\n1. Migraciones");
  const applied = await migrate();
  eq_(applied >= 4, true, `${applied} ficheros de migracion aplicados`);

  const now = Date.now();
  const DAY = 86400_000;
  await db.insert(assets).values([
    { id: "a-aapl", symbol: "AAPL", name: "Apple", assetClass: "equity", currency: "USD", providerId: "AAPL", createdAt: now },
    { id: "a-usdt", symbol: "USDT", name: "Tether", assetClass: "cash", currency: "USD", providerId: null, createdAt: now },
  ]);

  await db.insert(news).values([
    // Vieja: se descarta sin IA.
    { id: "n-old", headline: "Apple old news", url: "https://x/1", source: "Reuters", publishedAt: now - 30 * DAY, tickers: '["AAPL"]', processedAt: now, impact: "high", createdAt: now },
    // Impacto bajo: se descarta sin IA.
    { id: "n-low", headline: "Apple low impact", url: "https://x/2", source: "Reuters", publishedAt: now - DAY, tickers: '["AAPL"]', processedAt: now, impact: "low", createdAt: now },
    // Sin ticker seguido: se descarta sin IA.
    { id: "n-untracked", headline: "Random company news", url: "https://x/3", source: "Reuters", publishedAt: now - DAY, tickers: '["ZZZZ"]', processedAt: now, impact: "high", createdAt: now },
    // Ticker de efectivo: no cuenta como seguido.
    { id: "n-cash", headline: "Tether news", url: "https://x/4", source: "Reuters", publishedAt: now - DAY, tickers: '["USDT"]', processedAt: now, impact: "high", createdAt: now },
    // Sin resumir todavia: el motor no la toca.
    { id: "n-unsummarized", headline: "Apple fresh, not yet summarized", url: "https://x/5", source: "Reuters", publishedAt: now - DAY, tickers: '["AAPL"]', processedAt: null, impact: null, createdAt: now },
  ]);

  console.log("\n2. Filtro sin IA");
  const stats = await processEvents();
  eq_(stats.scanned, 4, "escanea solo las noticias ya resumidas");
  eq_(stats.skipped, 4, "las 4 se descartan sin llamar a la IA");
  eq_(stats.clusters, 0, "cero clusters, cero llamadas");

  const rows = await db.select({ id: news.id, done: news.eventProcessedAt }).from(news);
  const done = rows.filter((r) => r.done !== null).map((r) => r.id).sort();
  eq_(done, ["n-cash", "n-low", "n-old", "n-untracked"], "descartadas marcadas como procesadas");
  eq_(rows.find((r) => r.id === "n-unsummarized")?.done ?? null, null, "la no resumida sigue pendiente");

  const again = await processEvents();
  eq_(again.scanned, 0, "segunda pasada: nada que hacer (idempotente)");

  console.log("\n3. Feed y feedback");
  await db.insert(events).values({
    id: "ev-1",
    type: "earnings",
    primaryAssetId: "a-aapl",
    companies: '["AAPL"]',
    headline: "Apple supera estimaciones",
    fact: "Ingresos por encima de lo esperado.",
    inference: "",
    assessment: "Refuerza la tesis.",
    materiality: 60,
    confidence: 80,
    thesisImpact: 40,
    timeHorizon: "medium",
    portfolioRelevance: 100,
    sourceTier: 2,
    signalScore: 70,
    priority: "P2",
    occurredAt: now - DAY,
    clusterKey: "AAPL|2026-09-01|deadbeef",
    model: "test-model",
    promptVersion: "events-v1",
    createdAt: now,
  });
  await db.insert(events).values({
    id: "ev-noise",
    type: "other",
    primaryAssetId: null,
    companies: "[]",
    headline: "Ruido",
    fact: "Nada.",
    materiality: 5,
    confidence: 10,
    thesisImpact: 0,
    timeHorizon: "immediate",
    portfolioRelevance: 0,
    sourceTier: 4,
    signalScore: 8,
    priority: "P5",
    occurredAt: now,
    clusterKey: "X|2026-09-01|00000000",
    createdAt: now,
  });
  await db.insert(eventSources).values([
    { eventId: "ev-1", newsId: "n-old" },
    { eventId: "ev-1", newsId: "n-low" },
  ]);

  const signals = await recentEvents({ minPriority: "P3" });
  eq_(signals.map((e) => e.id), ["ev-1"], "P3 minimo excluye el ruido");
  eq_(signals[0].companies, ["AAPL"], "companies parseado a array");
  eq_(signals[0].sources.length, 2, "evento con sus 2 evidencias");
  eq_(signals[0].sources[0].tier, 2, "tier calculado por fuente (Reuters=2)");

  const all = await recentEvents({ minPriority: "P5" });
  eq_(all.map((e) => e.id), ["ev-noise", "ev-1"], "P5 incluye todo, mas reciente primero");

  await setEventFeedback("ev-1", "useful");
  let fb = await db.select({ f: events.feedback, at: events.feedbackAt }).from(events).where(eq(events.id, "ev-1"));
  eq_(fb[0].f, "useful", "feedback guardado");
  eq_(fb[0].at !== null, true, "feedbackAt fijado");
  await setEventFeedback("ev-1", null);
  fb = await db.select({ f: events.feedback, at: events.feedbackAt }).from(events).where(eq(events.id, "ev-1"));
  eq_([fb[0].f, fb[0].at], [null, null], "feedback se puede quitar");

  let threw = false;
  try {
    await setEventFeedback("ev-1", "meh" as never);
  } catch {
    threw = true;
  }
  eq_(threw, true, "feedback invalido se rechaza");

  console.log("\n4. Clave unica de cluster");
  let dup = false;
  try {
    await db.insert(events).values({
      id: "ev-dup",
      type: "earnings",
      companies: '["AAPL"]',
      headline: "Duplicado",
      fact: "x",
      materiality: 1,
      confidence: 1,
      thesisImpact: 0,
      timeHorizon: "short",
      portfolioRelevance: 0,
      sourceTier: 3,
      signalScore: 1,
      priority: "P5",
      occurredAt: now,
      clusterKey: "AAPL|2026-09-01|deadbeef",
      createdAt: now,
    });
  } catch {
    dup = true;
  }
  eq_(dup, true, "misma cluster_key no se puede insertar dos veces");

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
  .finally(() => {
    for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
      try {
        fs.rmSync(f);
      } catch {
        /* nada */
      }
    }
  });
