/**
 * Tests del universo cripto (puro, sin red).
 * Correr con: npm run test:crypto-universe
 */
import {
  daysSince,
  screenCoin,
  screenUniverse,
  summarize,
  worthHistory,
  MIN_MARKET_CAP,
  MIN_TURNOVER_PCT,
} from "../src/lib/crypto-universe";
import type { TopMarketRow } from "../src/lib/market/coingecko";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FALLA  ${label}\n        esperado ${b}\n        recibido ${a}`);
  }
}
function truthy(cond: boolean, label: string) {
  checks++;
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FALLA  ${label}`);
  }
}

const AHORA = Date.parse("2026-09-14T00:00:00Z");

const coin = (over: Partial<TopMarketRow> = {}): TopMarketRow => ({
  id: "bitcoin",
  symbol: "btc",
  name: "Bitcoin",
  market_cap_rank: 1,
  current_price: 77_200,
  market_cap: 1_500_000_000_000,
  total_volume: 30_000_000_000,
  ath: 124_000,
  ath_date: "2025-11-14T00:00:00.000Z",
  ath_change_percentage: -37.7,
  ...over,
});

console.log("\n# la caida desde maximos se calcula, no se copia");
{
  const btc = screenCoin(coin(), false, AHORA);
  eq(btc.drawdownPct, -37.7, "77.200 desde un maximo de 124.000 son -37,7%");
  eq(btc.athDaysAgo, 304, "y el maximo fue hace 304 dias");
  eq(btc.symbol, "BTC", "el simbolo en mayusculas");
  truthy(btc.usable, "bitcoin entra");
  eq(btc.reason, null, "sin motivo de exclusion");
  eq(daysSince(null, AHORA), null, "sin fecha no hay dias");
  eq(daysSince("no-es-fecha", AHORA), null, "una fecha ilegible tampoco rompe");
}

console.log("\n# la criba: lo que no se puede vender no es una oportunidad");
{
  // El caso que mas enganaria: -95% desde maximos y nadie con quien operar.
  const trampa = screenCoin(
    coin({ id: "zombi", symbol: "zmb", current_price: 0.001, ath: 0.02, market_cap: 60_000_000, total_volume: 3_000 }),
    false,
    AHORA,
  );
  eq(trampa.drawdownPct, -95, "ha caido un 95%");
  truthy(!trampa.usable, "y aun asi no entra");
  eq(trampa.reason, "no se negocia lo suficiente para salir", "por rotacion, no por la caida");
  truthy((trampa.turnoverPct ?? 0) < MIN_TURNOVER_PCT, "su rotacion esta por debajo del minimo");

  const pequena = screenCoin(coin({ market_cap: MIN_MARKET_CAP - 1, total_volume: 10_000_000 }), false, AHORA);
  eq(pequena.reason, "capitalizacion por debajo del minimo", "demasiado pequena");

  eq(screenCoin(coin({ current_price: null }), false, AHORA).reason, "sin precio", "sin precio no hay nada");
  eq(
    screenCoin(coin({ ath: null }), false, AHORA).reason,
    "sin maximo historico",
    "sin maximo no hay escalera de ciclo",
  );
}

console.log("\n# lo tuyo entra siempre, pero sin fingir que aprobo");
{
  // VTHO: en cartera, diminuta. Tiene que salir valorada y marcada.
  const vtho = screenCoin(
    coin({ id: "vethor", symbol: "vtho", market_cap: 1_000_000, total_volume: 100 }),
    true,
    AHORA,
  );
  truthy(vtho.held, "queda marcada como tuya");
  truthy(!vtho.usable, "no aprueba la criba");
  truthy(vtho.reason !== null, "y dice por que");
  truthy(worthHistory([vtho]).length === 1, "aun asi merece que le bajemos el historico");
}

console.log("\n# el universo: el mercado mas lo tuyo, sin duplicados");
{
  const rows = [
    coin(),
    coin({ id: "ethereum", symbol: "eth", name: "Ethereum", market_cap_rank: 2, current_price: 2512, ath: 4878, market_cap: 300e9, total_volume: 15e9 }),
    coin({ id: "binancecoin", symbol: "bnb", name: "BNB", market_cap_rank: 5, current_price: 600, ath: 793, market_cap: 85e9, total_volume: 2e9 }),
    // Mismo simbolo repetido: CoinGecko lo hace con tokens clonados.
    coin({ id: "bitcoin-wrapped", symbol: "btc", name: "Otro BTC", market_cap_rank: 180, market_cap: 1e8, total_volume: 1e6 }),
    // Una de las tuyas que NO esta entre las mayores.
    coin({ id: "vethor", symbol: "vtho", name: "VeThor", market_cap_rank: 400, current_price: 0.002, ath: 0.05, market_cap: 1_500_000, total_volume: 50_000 }),
  ];
  const uni = screenUniverse(rows, ["BNB", "VTHO"], AHORA);

  eq(uni.length, 4, "cuatro simbolos distintos: el BTC duplicado se descarta");
  eq(uni[0].symbol, "BNB", "lo tuyo primero");
  eq(uni[1].symbol, "VTHO", "aunque sea la 400 del ranking");
  eq(uni.slice(2).map((c) => c.symbol), ["BTC", "ETH"], "y el resto por capitalizacion");

  const res = summarize(uni);
  eq(res.seen, 4, "cuatro vistas");
  eq(res.held, 2, "dos tuyas");
  eq(res.heldMissing, 1, "una tuya no llega a los minimos: VTHO");
  truthy(res.usable >= 3, "BTC, ETH y BNB entran");

  // Ordenar por caida seria el error clasico: arriba lo que se esta muriendo.
  const porCaida = [...uni].sort((a, b) => (a.drawdownPct ?? 0) - (b.drawdownPct ?? 0));
  truthy(porCaida[0].symbol !== uni[0].symbol, "por eso NO se ordena por caida");
}

console.log(`\n${checks} comprobaciones, ${failures} fallos`);
process.exit(failures > 0 ? 1 : 0);
