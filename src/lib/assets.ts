import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, type Asset } from "@/db/schema";
import { coingecko, finnhub } from "./market";
import type { AssetClass } from "./market/types";
import { id } from "./utils";

/**
 * Tickers de cripto mas comunes, para no gastar llamadas de busqueda en
 * CoinGecko cada vez que sincronizamos un exchange.
 */
const COMMON_COINS: Record<string, { id: string; name: string }> = {
  BTC: { id: "bitcoin", name: "Bitcoin" },
  ETH: { id: "ethereum", name: "Ethereum" },
  SOL: { id: "solana", name: "Solana" },
  BNB: { id: "binancecoin", name: "BNB" },
  XRP: { id: "ripple", name: "XRP" },
  ADA: { id: "cardano", name: "Cardano" },
  DOGE: { id: "dogecoin", name: "Dogecoin" },
  AVAX: { id: "avalanche-2", name: "Avalanche" },
  DOT: { id: "polkadot", name: "Polkadot" },
  MATIC: { id: "matic-network", name: "Polygon" },
  POL: { id: "polygon-ecosystem-token", name: "Polygon" },
  LINK: { id: "chainlink", name: "Chainlink" },
  LTC: { id: "litecoin", name: "Litecoin" },
  ATOM: { id: "cosmos", name: "Cosmos" },
  UNI: { id: "uniswap", name: "Uniswap" },
  NEAR: { id: "near", name: "NEAR Protocol" },
  APT: { id: "aptos", name: "Aptos" },
  ARB: { id: "arbitrum", name: "Arbitrum" },
  OP: { id: "optimism", name: "Optimism" },
  TON: { id: "the-open-network", name: "Toncoin" },
  TRX: { id: "tron", name: "TRON" },
  SUI: { id: "sui", name: "Sui" },
  INJ: { id: "injective-protocol", name: "Injective" },
  RNDR: { id: "render-token", name: "Render" },
  SHIB: { id: "shiba-inu", name: "Shiba Inu" },
  PEPE: { id: "pepe", name: "Pepe" },
  FIL: { id: "filecoin", name: "Filecoin" },
  ETC: { id: "ethereum-classic", name: "Ethereum Classic" },
  XLM: { id: "stellar", name: "Stellar" },
  ALGO: { id: "algorand", name: "Algorand" },
  HBAR: { id: "hedera-hashgraph", name: "Hedera" },
  VET: { id: "vechain", name: "VeChain" },
  AAVE: { id: "aave", name: "Aave" },
  MKR: { id: "maker", name: "Maker" },
  GRT: { id: "the-graph", name: "The Graph" },
  SAND: { id: "the-sandbox", name: "The Sandbox" },
  MANA: { id: "decentraland", name: "Decentraland" },
  IMX: { id: "immutable-x", name: "Immutable" },
  STX: { id: "blockstack", name: "Stacks" },
  WIF: { id: "dogwifcoin", name: "dogwifhat" },
  BONK: { id: "bonk", name: "Bonk" },
  TAO: { id: "bittensor", name: "Bittensor" },
  SEI: { id: "sei-network", name: "Sei" },
  JUP: { id: "jupiter-exchange-solana", name: "Jupiter" },
  ONDO: { id: "ondo-finance", name: "Ondo" },
};

export function assetKey(symbol: string, assetClass: AssetClass) {
  return `${assetClass}:${symbol.toUpperCase()}`;
}

export async function findAsset(
  symbol: string,
  assetClass: AssetClass,
): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.symbol, symbol.toUpperCase()),
        eq(assets.assetClass, assetClass),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Devuelve el activo, creandolo si hace falta. Resuelve el providerId contra
 * CoinGecko o Finnhub para que los precios funcionen despues.
 */
export async function ensureAsset(input: {
  symbol: string;
  assetClass: AssetClass;
  name?: string;
  providerId?: string;
  logoUrl?: string | null;
}): Promise<Asset> {
  const symbol = input.symbol.toUpperCase();
  const existing = await findAsset(symbol, input.assetClass);
  if (existing) return existing;

  let providerId = input.providerId ?? null;
  let name = input.name ?? symbol;
  let logoUrl = input.logoUrl ?? null;

  if (!providerId) {
    if (input.assetClass === "crypto") {
      const common = COMMON_COINS[symbol];
      if (common) {
        providerId = common.id;
        name = input.name ?? common.name;
      } else {
        const hit = await coingecko.resolveId(symbol).catch(() => null);
        if (hit) {
          providerId = hit.providerId;
          name = input.name ?? hit.name;
          logoUrl = hit.logoUrl ?? null;
        }
      }
    } else {
      providerId = symbol;
      const p = await finnhub.profile(symbol).catch(() => null);
      if (p) {
        name = input.name ?? p.name ?? symbol;
        logoUrl = p.logo ?? null;
      }
    }
  }

  const row = {
    id: id(),
    symbol,
    name,
    assetClass: input.assetClass,
    currency: "USD",
    providerId,
    logoUrl,
    createdAt: Date.now(),
  };

  await db.insert(assets).values(row).onConflictDoNothing();
  // onConflictDoNothing puede no devolver fila; releemos para tener el id real.
  return (await findAsset(symbol, input.assetClass)) ?? (row as Asset);
}

export async function listAssets(): Promise<Asset[]> {
  return db.select().from(assets);
}
