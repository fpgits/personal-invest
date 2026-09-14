import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { universeCoins } from "@/db/schema-universe";
import { screenUniverse, summarize, type CoinScreen } from "./crypto-universe";
import { coingecko } from "./market";

/**
 * Llena el universo cripto. La decision vive en `crypto-universe.ts` y es
 * pura; aqui solo se pide la lista y se guarda.
 *
 * Una peticion. Cien monedas con precio, capitalizacion, volumen y maximo
 * historico. Comparado con lo de hoy —dos monedas fijas en un ajuste— la
 * diferencia no es de grado.
 */

/**
 * 200, no 100. La banda 101-200 tiene la misma proporcion de monedas ilíquidas
 * que la primera (22 de cada 100 en las dos) y capitalizaciones de 164 a 556
 * M$: son activos reales, no polvo. Y cuesta lo mismo — la peticion admite
 * hasta 250 de una vez. A partir de 250 si empieza a entrar basura.
 */
export const DEFAULT_TOP = 200;
const WRITE_CHUNK = 200;

export type CryptoSweepResult = {
  seen: number;
  usable: number;
  held: number;
  /** Tuyas que no llegan a los minimos: se valoran igual, pero conviene saberlo. */
  heldMissing: number;
  /** Tuyas que CoinGecko no devolvio: esas si se quedan fuera de verdad. */
  heldNotFound: string[];
  seconds: number;
  sourceDate: string;
  wrote: boolean;
};

/** Tus monedas: simbolo y el id de CoinGecko cuando se conoce. */
async function heldCoins(): Promise<{ symbols: string[]; ids: string[] }> {
  const rows = await db
    .select({ symbol: assets.symbol, providerId: assets.providerId })
    .from(assets)
    .where(eq(assets.assetClass, "crypto"))
    .catch(() => [] as Array<{ symbol: string; providerId: string | null }>);
  return {
    symbols: rows.map((r) => r.symbol.toUpperCase()),
    ids: rows.map((r) => r.providerId).filter((x): x is string => Boolean(x)),
  };
}

export async function sweepCrypto(
  opts: { top?: number; dryRun?: boolean; now?: number } = {},
): Promise<CryptoSweepResult> {
  const now = opts.now ?? Date.now();
  const t0 = Date.now();
  const sourceDate = new Date(now).toISOString().slice(0, 10);
  const top = opts.top ?? DEFAULT_TOP;

  const held = await heldCoins();

  // Las N mayores. Si alguna tuya no sale ahi, se pide aparte por su id: son
  // justo las que mas falta hacen y las que menos probable es que esten.
  const rows = await coingecko.topMarkets(top);
  const seenSymbols = new Set(rows.map((r) => (r.symbol ?? "").toUpperCase()));
  const missingIds = held.ids.filter((id) => !rows.some((r) => r.id === id));
  if (missingIds.length > 0) {
    const extra = await coingecko.topMarkets(missingIds.length, { ids: missingIds }).catch(() => []);
    rows.push(...extra);
    for (const r of extra) seenSymbols.add((r.symbol ?? "").toUpperCase());
  }

  const screened: CoinScreen[] = screenUniverse(rows, held.symbols, now);
  const res = summarize(screened);
  const heldNotFound = held.symbols.filter((s) => !seenSymbols.has(s));

  let wrote = false;
  if (!opts.dryRun && screened.length > 0) {
    for (let i = 0; i < screened.length; i += WRITE_CHUNK) {
      await db
        .insert(universeCoins)
        .values(
          screened.slice(i, i + WRITE_CHUNK).map((c) => ({
            id: c.id,
            symbol: c.symbol,
            name: c.name,
            rank: c.rank,
            price: c.price,
            marketCap: c.marketCap,
            volume24h: c.volume24h,
            ath: c.ath,
            drawdownPct: c.drawdownPct,
            athDaysAgo: c.athDaysAgo,
            turnoverPct: c.turnoverPct,
            held: c.held,
            usable: c.usable,
            reason: c.reason,
            sourceDate,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: universeCoins.id,
          set: {
            symbol: sql`excluded.symbol`,
            name: sql`excluded.name`,
            rank: sql`excluded.rank`,
            price: sql`excluded.price`,
            marketCap: sql`excluded.market_cap`,
            volume24h: sql`excluded.volume_24h`,
            ath: sql`excluded.ath`,
            drawdownPct: sql`excluded.drawdown_pct`,
            athDaysAgo: sql`excluded.ath_days_ago`,
            turnoverPct: sql`excluded.turnover_pct`,
            held: sql`excluded.held`,
            usable: sql`excluded.usable`,
            reason: sql`excluded.reason`,
            sourceDate: sql`excluded.source_date`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    wrote = true;
  }

  return {
    ...res,
    heldNotFound,
    seconds: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
    sourceDate,
    wrote,
  };
}
