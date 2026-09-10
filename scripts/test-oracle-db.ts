/**
 * Test de integracion del registro del oraculo contra SQLite local: aplica
 * las migraciones reales, registra un lote de llamadas con precio, avanza el
 * reloj, rellena retornos vencidos con el precio en cache y resume por
 * postura. Tambien cubre los ajustes del oraculo (valores por defecto y
 * validacion). No hay red.
 * Correr con: npm run test:oracle:db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { eq as eqId } from "drizzle-orm";

const dbFile = path.join(os.tmpdir(), `oracle-db-test-${process.pid}.db`);
function wipe() {
  for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* no existe */
    }
  }
}
wipe();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.TURSO_AUTH_TOKEN = "";

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

const DAY = 86400_000;

async function main() {
  const applied = await migrate();
  truthy(applied >= 11, `migraciones aplicadas (${applied}), incluida conviction_calls`);

  const { db } = await import("../src/db");
  const { assets, priceCache, convictionCalls } = await import("../src/db/schema");
  const { recordBatch, markForwardReturns, listCalls, summarizeCalls } = await import("../src/lib/conviction-calls");
  const { oracleFromSettings, ORACLE_DEFAULTS } = await import("../src/lib/settings");
  const { evaluate } = await import("../src/lib/conviction");

  // Activos y precios en cache.
  await db.insert(assets).values([
    { id: "a1", symbol: "GOOD", name: "Good Co", assetClass: "equity" },
    { id: "a2", symbol: "BAD", name: "Bad Co", assetClass: "equity" },
    { id: "a3", symbol: "VOO", name: "Vanguard S&P", assetClass: "equity" },
  ]);
  await db.insert(priceCache).values([
    { assetId: "a1", price: 100, updatedAt: 1 },
    { assetId: "a2", price: 100, updatedAt: 1 },
    { assetId: "a3", price: 100, updatedAt: 1 },
  ]);

  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const good = evaluate({ symbol: "GOOD", assetClass: "equity", price: 100, riskFreeRate: 4, fundamentals: null, financials: null, position: { unrealizedPct: 0, weight: 5 } });
  // Sin datos sale sin cobertura; forzamos posturas para el test de medicion.
  const buy = { ...good, posture: "buy" as const, score: 75, confidence: 1, dataQuality: "full" as const };
  const sell = { ...good, symbol: "BAD", posture: "reduce" as const, score: 35, confidence: 1, dataQuality: "full" as const };

  console.log("\n# registrar lote");
  const batchId = await recordBatch({
    kind: "plan",
    items: [
      { result: buy, assetId: "a1", assetClass: "equity", price: 100, planAmount: 1500 },
      { result: sell, assetId: "a2", assetClass: "equity", price: 100, planAmount: null },
    ],
    benchmark: { symbol: "VOO", assetId: "a3", price: 100 },
    now: t0,
  });
  const stored = await listCalls();
  eq(stored.length, 3, "tres filas: compra, recorte y benchmark");
  truthy(stored.every((c) => c.batchId === batchId), "mismo lote");
  eq(stored.find((c) => c.symbol === "GOOD")?.planAmount, 1500, "importe del plan guardado");
  eq(stored.find((c) => c.kind === "benchmark")?.symbol, "VOO", "benchmark guardado");

  console.log("\n# marcar retornos: nada vence antes de 30 dias");
  eq(await markForwardReturns(t0 + 10 * DAY), 0, "a los 10 dias no se marca nada");

  console.log("\n# marcar retornos a los 100 dias con precios nuevos");
  await db.update(priceCache).set({ price: 120 }).where(eqId(priceCache.assetId, "a1"));
  await db.update(priceCache).set({ price: 80 }).where(eqId(priceCache.assetId, "a2"));
  await db.update(priceCache).set({ price: 110 }).where(eqId(priceCache.assetId, "a3"));
  const marked = await markForwardReturns(t0 + 100 * DAY);
  eq(marked, 3, "tres filas marcadas");
  const after = await listCalls();
  const g = after.find((c) => c.symbol === "GOOD")!;
  const b = after.find((c) => c.symbol === "BAD")!;
  const v = after.find((c) => c.symbol === "VOO")!;
  eq([g.ret30, g.ret90, g.ret180], [20, 20, null], "GOOD: +20% a 30 y 90 dias, 180 pendiente");
  eq([b.ret30, b.ret90], [-20, -20], "BAD: -20%");
  eq(v.ret90, 10, "benchmark +10%");

  console.log("\n# idempotencia: volver a marcar no cambia lo ya escrito");
  await db.update(priceCache).set({ price: 150 }).where(eqId(priceCache.assetId, "a1"));
  eq(await markForwardReturns(t0 + 101 * DAY), 0, "sin horizontes nuevos vencidos, nada que marcar");
  eq((await listCalls()).find((c) => c.symbol === "GOOD")?.ret30, 20, "ret30 conserva el valor original");
  eq(await markForwardReturns(t0 + 200 * DAY), 3, "a los 200 dias se rellena el de 180");
  eq((await listCalls()).find((c) => c.symbol === "GOOD")?.ret180, 50, "ret180 usa el precio de ese momento");

  console.log("\n# resumen por postura");
  const stats = summarizeCalls(await listCalls());
  const sBuy = stats.find((s) => s.posture === "buy")!;
  const sReduce = stats.find((s) => s.posture === "reduce")!;
  const sBench = stats.find((s) => s.posture === "benchmark")!;
  eq(sBuy.avg[30], 20, "compra: retorno medio 30d");
  eq(sBuy.hitRate[30], 100, "compra: acierto 100% (subio)");
  eq(sReduce.hitRate[30], 100, "recorte: acierto 100% (cayo)");
  eq(sBench.hitRate[30], null, "benchmark sin tasa de acierto");
  eq(sBench.avg[90], 10, "benchmark retorno medio 90d");
  eq(sBuy.counts[365], 0, "365d aun sin filas vencidas");

  // -------------------------------------------------------------------------
  // Ciclo cripto: el modelo tiene que ser MEDIBLE. BTC/ETH no estan en la
  // cartera ni en la cache de precios, asi que sin el resolutor propio no
  // venceria ninguna de sus llamadas y la escalera seria opinion sin marcador.
  console.log("\n# ciclo cripto: se registra y se mide aparte");
  const { summarizeCycleCalls } = await import("../src/lib/conviction-calls");
  const t1 = Date.parse("2026-02-01T00:00:00Z");
  await recordBatch({
    kind: "plan",
    items: [],
    cycleItems: [
      {
        symbol: "BTC", assetId: null, posture: "cycle_hold", multiplier: 1, ladderMultiplier: 1.5,
        confirmed: false, price: 60000, ath: 126000, drawdownPct: -52.4, planAmount: 1500,
        reason: "sigue marcando minimos nuevos",
      },
      {
        symbol: "ETH", assetId: null, posture: "cycle_extra", multiplier: 1.5, ladderMultiplier: 1.5,
        confirmed: true, price: 2000, ath: 4800, drawdownPct: -58.3, planAmount: 1500,
        reason: "25 dias sin minimos nuevos",
      },
    ],
    now: t1,
  });
  const withCycle = await listCalls();
  const btc = withCycle.find((c) => c.symbol === "BTC")!;
  eq(btc.kind, "cycle", "la fila de cripto va con kind cycle");
  eq(btc.assetClass, "crypto", "clase de activo cripto");
  eq(btc.confidence, 0, "tramo retenido: confianza 0 (la escalera no solto)");
  eq(btc.fairValue, 126000, "guarda el maximo historico como referencia");
  eq(btc.upsidePct, -52.4, "y la caida desde ese maximo");
  eq(withCycle.find((c) => c.symbol === "ETH")?.score, 150, "score = multiplicador aplicado x100");

  console.log("\n# la tabla de bolsa no se contamina con cripto");
  const statsAfter = summarizeCalls(withCycle);
  truthy(
    !statsAfter.some((s) => String(s.posture).startsWith("cycle_")),
    "summarizeCalls ignora las llamadas de ciclo",
  );
  eq(statsAfter.find((s) => s.posture === "buy")!.n, 1, "la compra de bolsa sigue contando una sola vez");

  console.log("\n# retornos de cripto: precio resuelto fuera de la cache");
  // BTC cae otro 25%, ETH sube 50%.
  const cryptoNow = new Map([["BTC", 45000], ["ETH", 3000]]);
  const marked2 = await markForwardReturns(t1 + 100 * DAY, async (s) => cryptoNow.get(s) ?? null);
  truthy(marked2 >= 2, `se marcan las dos filas de cripto (${marked2})`);
  const cyc = summarizeCycleCalls(await listCalls());
  const held = cyc.find((s) => s.posture === "cycle_hold")!;
  const extra = cyc.find((s) => s.posture === "cycle_extra")!;
  eq(held.avg[90], -25, "tramo retenido: el precio siguio cayendo -25%");
  eq(held.hitRate[90], 100, "retener acerto: acertar aqui es que cayera");
  eq(extra.avg[90], 50, "aporte extra: +50%");
  eq(extra.hitRate[90], 100, "el aporte extra acerto: subio");
  eq(held.label, "Tramo retenido", "la fila trae su etiqueta lista para la UI");

  console.log("\n# apuestas de situacion especial: se registran y se miden como cesta");
  const { summarizeSpecialCalls } = await import("../src/lib/conviction-calls");
  const t2 = Date.parse("2026-03-01T00:00:00Z");
  await db.insert(assets).values([
    { id: "s1", symbol: "GPRO", name: "GoPro", assetClass: "equity" },
    { id: "s2", symbol: "DEAD", name: "Dead Co", assetClass: "equity" },
  ]);
  await db.insert(priceCache).values([
    { assetId: "s1", price: 0.68, updatedAt: 1 },
    { assetId: "s2", price: 2, updatedAt: 1 },
  ]);
  await recordBatch({
    kind: "plan",
    items: [],
    specialItems: [
      { symbol: "GPRO", assetId: "s1", score: 84, price: 0.68, planAmount: 1400, reason: "busca comprador" },
      { symbol: "DEAD", assetId: "s2", score: 72, price: 2, planAmount: 1400, reason: "going concern" },
    ],
    now: t2,
  });
  const sp = (await listCalls()).filter((c) => c.kind === "special");
  eq(sp.length, 2, "dos apuestas guardadas con kind special");
  eq(sp[0].posture, "special_bet", "postura propia, no comprar");
  truthy(!summarizeCalls(await listCalls()).some((s) => String(s.posture) === "special_bet"), "la tabla de bolsa no las mezcla");
  // GPRO x2.5, DEAD a cero.
  await db.update(priceCache).set({ price: 1.69 }).where(eqId(priceCache.assetId, "s1"));
  await db.update(priceCache).set({ price: 0.01 }).where(eqId(priceCache.assetId, "s2"));
  await markForwardReturns(t2 + 100 * DAY, async () => null);
  const st = summarizeSpecialCalls(await listCalls());
  eq(st.n, 2, "N = 2");
  eq(st.hitRate[90], 50, "una de dos subio: 50%");
  truthy(st.avg[90]! > 0, `y la cesta gana en media aunque una se fue a cero (${st.avg[90]}%)`);
  truthy(st.best90! > 140 && st.worst90! < -99, `mejor +${st.best90}% / peor ${st.worst90}%: la distribucion, no la media`);

  console.log("\n# ajustes del oraculo");
  const d = oracleFromSettings({});
  eq(d, ORACLE_DEFAULTS, "sin ajustes, valores por defecto");
  const custom = oracleFromSettings({
    oracle_monthly_equity: "5000",
    oracle_max_weight_pct: "20",
    oracle_reserve_symbol: "none",
    oracle_crypto_core: "BTC:70,ETH:30",
    oracle_contribution_day: "15",
    oracle_buy_threshold: "abc",
  });
  eq(custom.monthlyEquity, 5000, "importe personalizado");
  eq(custom.maxWeightPct, 20, "peso maximo personalizado");
  eq(custom.reserveSymbol, null, "'none' = sin reserva");
  eq(custom.cryptoCore, "BTC:70,ETH:30", "nucleo cripto personalizado");
  eq(custom.contributionDay, 15, "dia de aporte");
  eq(custom.buyThreshold, 64, "valor invalido cae al defecto");

  // Limpieza.
  await db.delete(convictionCalls);
}

main()
  .then(() => {
    wipe();
    console.log(`\n${checks} comprobaciones, ${failures} fallos`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((e) => {
    wipe();
    console.error(e);
    process.exit(1);
  });
