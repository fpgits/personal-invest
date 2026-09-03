import type { Exchange } from "ccxt";
import { decrypt } from "@/lib/crypto";
import type { Account } from "@/db/schema";

/**
 * Exchanges que exponemos en la UI. ccxt soporta ~100, pero estos son los
 * que tienen fetchBalance y fetchMyTrades fiables con claves read-only.
 */
export const SUPPORTED_EXCHANGES = [
  { id: "binance", name: "Binance", needsPassphrase: false },
  { id: "bybit", name: "Bybit", needsPassphrase: false },
  { id: "kraken", name: "Kraken", needsPassphrase: false },
  { id: "okx", name: "OKX", needsPassphrase: true },
  { id: "kucoin", name: "KuCoin", needsPassphrase: true },
  { id: "coinbase", name: "Coinbase", needsPassphrase: false },
  { id: "bitget", name: "Bitget", needsPassphrase: true },
  { id: "mexc", name: "MEXC", needsPassphrase: false },
  { id: "gateio", name: "Gate.io", needsPassphrase: false },
  { id: "cryptocom", name: "Crypto.com", needsPassphrase: false },
] as const;

export type SupportedExchangeId = (typeof SUPPORTED_EXCHANGES)[number]["id"];

export function isSupported(id: string): id is SupportedExchangeId {
  return SUPPORTED_EXCHANGES.some((e) => e.id === id);
}

/**
 * Instancia ccxt a partir de una cuenta guardada. Las claves se descifran
 * aqui y no salen de este modulo.
 *
 * Nunca llamamos a endpoints de trading: solo fetchBalance, fetchMyTrades y
 * fetchLedger. Aun asi, usa siempre claves read-only.
 */
export async function clientFor(account: Account): Promise<Exchange> {
  if (!account.exchangeId || !isSupported(account.exchangeId)) {
    throw new Error(`Exchange no soportado: ${account.exchangeId}`);
  }
  if (!account.apiKeyEnc || !account.apiSecretEnc) {
    throw new Error(`La cuenta ${account.name} no tiene claves guardadas`);
  }

  const ccxt = await import("ccxt");
  const Ctor = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[
    account.exchangeId
  ];
  if (!Ctor) throw new Error(`ccxt no expone ${account.exchangeId}`);

  const ex = new Ctor({
    apiKey: decrypt(account.apiKeyEnc),
    secret: decrypt(account.apiSecretEnc),
    password: account.apiPassphraseEnc
      ? decrypt(account.apiPassphraseEnc)
      : undefined,
    enableRateLimit: true,
    timeout: 20000,
    options: { adjustForTimeDifference: true },
  });

  return ex;
}

/** Comprueba que las claves funcionan sin escribir nada. */
export async function testConnection(
  account: Account,
): Promise<{ ok: boolean; error?: string; assets?: number }> {
  try {
    const ex = await clientFor(account);
    const balance = await ex.fetchBalance();
    const nonZero = Object.entries(balance.total ?? {}).filter(
      ([, v]) => typeof v === "number" && v > 0,
    );
    return { ok: true, assets: nonZero.length };
  } catch (e) {
    return { ok: false, error: cleanError(e) };
  }
}

export type ExchangeBalance = {
  currency: string;
  amount: number;
  /** true si es efectivo (stablecoin o divisa), no una posicion de inversion. */
  isCash: boolean;
};

export async function fetchBalances(ex: Exchange): Promise<ExchangeBalance[]> {
  const balance = await ex.fetchBalance();
  return Object.entries(balance.total ?? {})
    .filter(([, v]) => typeof v === "number" && v > 1e-8)
    .map(([currency, amount]) => ({
      currency,
      amount: amount as number,
      isCash: isCash(currency),
    }));
}

export type ExchangeTrade = {
  externalId: string;
  base: string;
  quote: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  fee: number;
  feeCurrency: string | null;
  timestamp: number;
};

/**
 * Historial de operaciones. Muchos exchanges exigen simbolo, asi que
 * probamos los pares mas comunes de cada moneda que tengas en balance.
 */
export async function fetchTrades(
  ex: Exchange,
  currencies: string[],
  since?: number,
): Promise<ExchangeTrade[]> {
  const out: ExchangeTrade[] = [];
  const seen = new Set<string>();

  if (!ex.has["fetchMyTrades"]) return out;

  await ex.loadMarkets().catch(() => undefined);
  const quotes = ["USDT", "USD", "USDC", "EUR", "BTC"];

  for (const base of currencies) {
    for (const quote of quotes) {
      const symbol = `${base}/${quote}`;
      if (!ex.markets || !ex.markets[symbol]) continue;
      try {
        const trades = await ex.fetchMyTrades(symbol, since, 500);
        for (const t of trades) {
          const key = String(t.id ?? `${symbol}-${t.timestamp}-${t.amount}`);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            externalId: key,
            base,
            quote,
            side: t.side === "sell" ? "sell" : "buy",
            amount: Number(t.amount ?? 0),
            price: Number(t.price ?? 0),
            fee: Number(t.fee?.cost ?? 0),
            feeCurrency: t.fee?.currency ?? null,
            timestamp: Number(t.timestamp ?? Date.now()),
          });
        }
      } catch {
        // Par sin permisos o sin historial. Seguimos con el siguiente.
      }
    }
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export type ExchangeTransfer = {
  /** id estable del movimiento (incluye el sentido para no colisionar). */
  id: string;
  kind: "deposit" | "withdrawal";
  /** Magnitud positiva, en `currency`. */
  amount: number;
  currency: string;
  occurredAt: number;
  note?: string | null;
};

/**
 * Depositos y retiros de EFECTIVO (fiat y stablecoins): el "cash inyectado".
 * No incluye transferencias de cripto de inversion (mover monedas no es cash).
 *
 * Mejor esfuerzo: la API de muchos exchanges limita cada consulta a una
 * ventana (~90 dias) y fiat/cripto van por endpoints distintos. Paginamos
 * hacia atras por ventanas; en el primer sync se hace un barrido profundo y
 * en los siguientes solo la ventana reciente (los aportes viejos ya estan
 * guardados y el upsert es idempotente). Cualquier fallo devuelve lo que haya.
 */
export async function fetchCashTransfers(
  ex: Exchange,
  opts: { deep?: boolean } = {},
): Promise<ExchangeTransfer[]> {
  const out: ExchangeTransfer[] = [];
  const seen = new Set<string>();
  const WINDOW = 90 * 86_400_000;
  const FLOOR = Date.parse("2019-01-01T00:00:00Z");
  const MAX_WINDOWS = opts.deep ? 30 : 1; // profundo ≈ hasta ~7 años; incremental = 90 días

  const collect = (
    list: Array<Record<string, unknown>> | undefined,
    kind: "deposit" | "withdrawal",
  ) => {
    for (const d of list ?? []) {
      const currency = String(d.currency ?? "").toUpperCase();
      if (!currency || !isCash(currency)) continue;
      const amount = Math.abs(Number(d.amount ?? 0));
      if (!(amount > 0)) continue;
      const status = String(d.status ?? "ok").toLowerCase();
      if (["failed", "canceled", "cancelled", "rejected", "pending"].includes(status)) continue;
      const raw = String(d.id ?? d.txid ?? `${currency}-${d.timestamp}-${amount}`);
      const key = `${kind}:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind,
        amount,
        currency,
        occurredAt: Number(d.timestamp ?? Date.now()),
        note: null,
      });
    }
  };

  const now = Date.now();
  for (let w = 0; w < MAX_WINDOWS; w++) {
    const end = now - w * WINDOW;
    const start = Math.max(FLOOR, end - WINDOW);
    if (end <= FLOOR) break;
    // endTime es lo que piden Binance y compañía para acotar la ventana.
    const params = { endTime: end } as Record<string, unknown>;
    if (ex.has["fetchDeposits"]) {
      try {
        collect(
          (await ex.fetchDeposits(undefined, start, undefined, params)) as unknown as Array<
            Record<string, unknown>
          >,
          "deposit",
        );
      } catch {
        /* ventana sin permisos o no soportada: seguimos */
      }
    }
    if (ex.has["fetchWithdrawals"]) {
      try {
        collect(
          (await ex.fetchWithdrawals(undefined, start, undefined, params)) as unknown as Array<
            Record<string, unknown>
          >,
          "withdrawal",
        );
      } catch {
        /* idem */
      }
    }
  }

  return out.sort((a, b) => a.occurredAt - b.occurredAt);
}

// Efectivo: divisas y stablecoins. No son posiciones de inversion, se muestran
// como saldo en efectivo y valen 1:1 en USD.
const CASH = new Set([
  "USD", "EUR", "GBP",
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDP", "PYUSD", "USDD", "GUSD",
]);

export function isCash(code: string) {
  return CASH.has(code.toUpperCase());
}

/** Quita cualquier rastro de claves de los mensajes de error de ccxt. */
export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/[A-Za-z0-9_-]{32,}/g, "[oculto]")
    .replace(/apiKey["\s:=]+\S+/gi, "apiKey=[oculto]")
    .slice(0, 300);
}
