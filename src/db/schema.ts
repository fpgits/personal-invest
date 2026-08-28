import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Un instrumento: accion, ETF o cripto. */
export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    /** equity | etf | crypto */
    assetClass: text("asset_class").notNull(),
    currency: text("currency").notNull().default("USD"),
    /** Symbol de Finnhub (AAPL) o id de CoinGecko (bitcoin). */
    providerId: text("provider_id"),
    logoUrl: text("logo_url"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("assets_symbol_class_idx").on(t.symbol, t.assetClass),
    index("assets_class_idx").on(t.assetClass),
  ],
);

/** Origen de las posiciones: exchange con API, broker por CSV, wallet o manual. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** exchange | broker | wallet | manual */
  type: text("type").notNull(),
  /** id de ccxt cuando type = exchange (binance, bybit, kraken, okx...) */
  exchangeId: text("exchange_id"),
  apiKeyEnc: text("api_key_enc"),
  apiSecretEnc: text("api_secret_enc"),
  apiPassphraseEnc: text("api_passphrase_enc"),
  /** active | error | disabled */
  status: text("status").notNull().default("active"),
  lastSyncAt: integer("last_sync_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull().default(now),
});

/** Libro de operaciones. Todo el P&L se deriva de aqui. */
export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** buy | sell | dividend | fee | transfer_in | transfer_out */
    type: text("type").notNull(),
    quantity: real("quantity").notNull(),
    /** Precio por unidad en `currency`. */
    price: real("price").notNull().default(0),
    fee: real("fee").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    executedAt: integer("executed_at").notNull(),
    /** id del trade en el exchange, para no duplicar en cada sync */
    externalId: text("external_id"),
    /** manual | csv | sync */
    source: text("source").notNull().default("manual"),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("tx_account_external_idx").on(t.accountId, t.externalId),
    index("tx_asset_idx").on(t.assetId),
    index("tx_executed_idx").on(t.executedAt),
  ],
);

/** Ultimo precio conocido por activo. Evita reventar los rate limits. */
export const priceCache = sqliteTable("price_cache", {
  assetId: text("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  price: real("price").notNull(),
  change24h: real("change_24h"),
  changePct24h: real("change_pct_24h"),
  currency: text("currency").notNull().default("USD"),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Foto diaria de la cartera, para el grafico historico. */
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM-DD */
    date: text("date").notNull(),
    totalValue: real("total_value").notNull(),
    costBasis: real("cost_basis").notNull(),
    unrealizedPnl: real("unrealized_pnl").notNull(),
    realizedPnl: real("realized_pnl").notNull(),
    /** JSON: reparto por activo y por clase en ese momento */
    breakdown: text("breakdown").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("snapshots_date_idx").on(t.date)],
);

export const watchlist = sqliteTable(
  "watchlist",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    note: text("note"),
    targetPrice: real("target_price"),
    /** above | below | null */
    alertDirection: text("alert_direction"),
    addedAt: integer("added_at").notNull().default(now),
  },
  (t) => [uniqueIndex("watchlist_asset_idx").on(t.assetId)],
);

export const news = sqliteTable(
  "news",
  {
    id: text("id").primaryKey(),
    headline: text("headline").notNull(),
    url: text("url").notNull(),
    source: text("source"),
    imageUrl: text("image_url"),
    publishedAt: integer("published_at").notNull(),
    /** resumen generado por IA */
    summary: text("summary"),
    /** bullish | bearish | neutral */
    sentiment: text("sentiment"),
    /** high | medium | low */
    impact: text("impact"),
    /** JSON array de symbols relacionados */
    tickers: text("tickers").notNull().default("[]"),
    processedAt: integer("processed_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("news_url_idx").on(t.url),
    index("news_published_idx").on(t.publishedAt),
  ],
);

/** Tesis de inversion por activo, escrita por ti o generada por IA. */
export const theses = sqliteTable(
  "theses",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    thesis: text("thesis").notNull(),
    /** 1 a 5 */
    conviction: integer("conviction"),
    targetPrice: real("target_price"),
    horizon: text("horizon"),
    /** manual | modelo usado */
    generatedBy: text("generated_by").notNull().default("manual"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("theses_asset_idx").on(t.assetId)],
);

export const aiThreads = sqliteTable("ai_threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("Nueva conversacion"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => aiThreads.id, { onDelete: "cascade" }),
    /** user | assistant | system */
    role: text("role").notNull(),
    content: text("content").notNull(),
    model: text("model"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("ai_messages_thread_idx").on(t.threadId, t.createdAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull().default(now),
    finishedAt: integer("finished_at"),
    /** running | ok | error */
    status: text("status").notNull().default("running"),
    imported: integer("imported").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("sync_runs_account_idx").on(t.accountId, t.startedAt)],
);

export type Asset = typeof assets.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type PriceRow = typeof priceCache.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
export type NewsRow = typeof news.$inferSelect;
export type Thesis = typeof theses.$inferSelect;
