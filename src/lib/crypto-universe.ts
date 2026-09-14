import type { TopMarketRow } from "./market/coingecko";

/**
 * El universo cripto: las mayores del mercado, no solo las dos del nucleo.
 *
 * Hoy el oraculo opina sobre BTC y ETH y punto — ni siquiera sobre las cinco
 * monedas que tienes en cartera. Aqui se arma la lista de candidatas: las N
 * mayores por capitalizacion UNIDAS a las tuyas, que es la misma regla que en
 * bolsa (el mercado mas lo que ya tienes).
 *
 * Una sola peticion a CoinGecko trae hasta 250 con precio, capitalizacion,
 * volumen, maximo historico y su fecha. Con eso se puede cribar sin bajar el
 * historico de ninguna: el historico largo, que es lo caro, solo hace falta
 * despues para las que sobrevivan a la criba.
 *
 * Todo lo de este archivo es puro: entra lo que devuelve la API, sale la
 * criba. La red vive en `crypto-universe-run.ts`.
 */

/** Una moneda ya cribada, lista para decidir si merece historico. */
export type CoinScreen = {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  ath: number | null;
  /** Caida desde el maximo historico, en % y negativa. */
  drawdownPct: number | null;
  athDaysAgo: number | null;
  /** Volumen de 24 h sobre capitalizacion, en %. Mide si se puede salir. */
  turnoverPct: number | null;
  /** En cartera: entra siempre, pase o no la criba. */
  held: boolean;
  /** Cumple los minimos para que valga la pena valorarla. */
  usable: boolean;
  /** Por que no entra, cuando no entra. */
  reason: string | null;
};

/**
 * Minimos para entrar. No son opiniones de inversion: son el umbral por debajo
 * del cual el dato no significa nada.
 *
 * El de rotacion es el mas importante y el menos obvio: una moneda puede estar
 * entre las 100 mayores y no tener con quien negociar. Una caida del 90% desde
 * maximos en algo que mueve el 0,01% de su capitalizacion al dia no es una
 * oportunidad, es una trampa — el precio que ves no es un precio al que puedas
 * salir.
 */

/**
 * Medido contra CoinGecko el 14/09/2026: en las 250 mayores NO HAY NINGUNA por
 * debajo de 115 M$. El puesto 100 es XDC con 556 M$ y el 200 es BORG con 164.
 * O sea que un suelo de 50 M no filtra nada — el corte real lo pone el propio
 * ranking. Se deja bajo a proposito, como red de seguridad por si algun dia se
 * amplia el universo, pero no cuenta con el nadie.
 */
export const MIN_MARKET_CAP = 50_000_000;
/**
 * Este si trabaja: 22 de las 100 primeras estan por debajo. Y sigue firme en
 * la banda 101-200, tambien 22 de 100 — que es justo el dato que dice que
 * ampliar a 200 no baja la calidad, solo el tamaño.
 */
export const MIN_TURNOVER_PCT = 0.5;
/** Sin maximo historico no hay escalera: es la referencia de todo el ciclo. */
export const REQUIRE_ATH = true;

/**
 * Las estables no tienen ciclo, y la escalera no lo sabe.
 *
 * Esto no es limpieza cosmetica. En las 100 mayores hay NUEVE estables, y sus
 * caidas desde maximos son reales pero no significan nada: USDT marca -24%,
 * DAI -18%, USDC -4%. Son despegues viejos de un pico puntual. Para un motor
 * que compra tramos cuando algo cae mucho desde su maximo, un USDT a "-24% del
 * maximo" es una oportunidad — y es una moneda cuyo precio objetivo es un
 * dolar, por diseño.
 *
 * Un 9% del universo serian señales falsas con pinta perfectamente razonable.
 *
 * La lista hay que revisarla: salen estables nuevas cada año. El patron del
 * nombre cubre a las que se llaman como lo que son, que son casi todas.
 */
const STABLE_SYMBOL =
  /^(usdt|usdc|dai|usde|usds|susds|fdusd|pyusd|tusd|usd1|rlusd|busd|frax|lusd|gusd|usdp|usdf|usdx|usdtb|usdd|buidl|eurc|eurs|eurt|steur)$/i;
const STABLE_NAME = /\b(tether|usd|stablecoin|stable coin|dai|euro coin)\b/i;

/** Si es una estable. Puro. */
export function isStablecoin(symbol: string, name: string): boolean {
  return STABLE_SYMBOL.test(symbol.trim()) || STABLE_NAME.test(name ?? "");
}

const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** Dias desde una fecha ISO. Puro. */
export function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 86400_000));
}

/**
 * Criba una fila del mercado.
 *
 * `held` manda sobre todo lo demas: una moneda que tienes se valora aunque no
 * llegue a los minimos, porque necesitas saber que hacer con ella. Lo que no
 * se hace es fingir que la criba la aprobo — queda marcada y con su motivo.
 */
export function screenCoin(row: TopMarketRow, held: boolean, now: number): CoinScreen {
  const marketCap = fin(row.market_cap) ? row.market_cap : null;
  const volume24h = fin(row.total_volume) ? row.total_volume : null;
  const price = fin(row.current_price) ? row.current_price : null;
  const ath = fin(row.ath) && row.ath > 0 ? row.ath : null;
  const turnoverPct =
    marketCap !== null && marketCap > 0 && volume24h !== null ? (volume24h / marketCap) * 100 : null;

  // La caida se calcula, no se copia: `ath_change_percentage` es el mismo
  // numero pero de la API, y si algun dia cambia de signo o de escala esto
  // seguiria siendo correcto.
  const drawdownPct = price !== null && ath !== null ? ((price - ath) / ath) * 100 : null;

  let reason: string | null = null;
  if (price === null) reason = "sin precio";
  else if (isStablecoin(row.symbol ?? "", row.name ?? "")) reason = "estable: no tiene ciclo que medir";
  else if (REQUIRE_ATH && ath === null) reason = "sin maximo historico";
  else if (marketCap === null || marketCap < MIN_MARKET_CAP) reason = "capitalizacion por debajo del minimo";
  else if (turnoverPct === null || turnoverPct < MIN_TURNOVER_PCT) reason = "no se negocia lo suficiente para salir";

  return {
    id: row.id,
    symbol: (row.symbol ?? "").toUpperCase(),
    name: row.name ?? row.id,
    rank: fin(row.market_cap_rank) ? row.market_cap_rank : null,
    price,
    marketCap,
    volume24h,
    ath,
    drawdownPct: drawdownPct === null ? null : Math.round(drawdownPct * 10) / 10,
    athDaysAgo: daysSince(row.ath_date, now),
    turnoverPct: turnoverPct === null ? null : Math.round(turnoverPct * 100) / 100,
    held,
    usable: reason === null,
    reason,
  };
}

/**
 * El universo entero, cribado y ordenado.
 *
 * Orden: primero lo tuyo (necesitas saber que hacer con ello), luego por
 * capitalizacion. No por caida: ordenar por "la que mas ha bajado" pone arriba
 * exactamente lo que esta muriendo, que es el error clasico de un buscador de
 * gangas sin filtros.
 */
export function screenUniverse(
  rows: TopMarketRow[],
  heldSymbols: Iterable<string>,
  now = Date.now(),
): CoinScreen[] {
  const held = new Set([...heldSymbols].map((s) => s.toUpperCase()));
  const seen = new Set<string>();
  const out: CoinScreen[] = [];
  for (const row of rows) {
    const sym = (row.symbol ?? "").toUpperCase();
    // CoinGecko puede traer dos ids con el mismo simbolo; gana el de mayor
    // capitalizacion, que es el que llega antes por el orden de la peticion.
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(screenCoin(row, held.has(sym), now));
  }
  return out.sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1;
    return (a.rank ?? 9999) - (b.rank ?? 9999);
  });
}

/** Las que merecen que se les baje el historico largo. */
export function worthHistory(screened: CoinScreen[]): CoinScreen[] {
  return screened.filter((c) => c.usable || c.held);
}

/** Resumen de una pasada, para poder decir de cuantas sabemos algo. */
export function summarize(screened: CoinScreen[]): {
  seen: number;
  usable: number;
  held: number;
  heldMissing: number;
} {
  return {
    seen: screened.length,
    usable: screened.filter((c) => c.usable).length,
    held: screened.filter((c) => c.held).length,
    heldMissing: screened.filter((c) => c.held && !c.usable).length,
  };
}
