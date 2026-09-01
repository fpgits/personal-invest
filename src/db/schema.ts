import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
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
  /**
   * type = exchange: id de ccxt (binance, bybit, kraken, okx...)
   * type = broker:   id del broker, por ahora solo "ibkr"
   */
  exchangeId: text("exchange_id"),
  /**
   * API key del exchange, o el token de Flex Web Service cuando es IBKR.
   * Siempre cifrado.
   */
  apiKeyEnc: text("api_key_enc"),
  apiSecretEnc: text("api_secret_enc"),
  apiPassphraseEnc: text("api_passphrase_enc"),
  /** Id de la Flex Query de IBKR. Sin el token no sirve de nada. */
  flexQueryId: text("flex_query_id"),
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
    /** Cuando el motor de eventos ya consumio esta noticia (o la descarto). */
    eventProcessedAt: integer("event_processed_at"),
    /**
     * Intentos fallidos del motor de eventos sobre esta noticia. Con un tope,
     * un cluster que siempre falla (moderacion, prompt que el modelo rechaza)
     * se abandona en vez de bloquear cada pasada.
     */
    eventAttempts: integer("event_attempts").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("news_url_idx").on(t.url),
    index("news_published_idx").on(t.publishedAt),
    index("news_event_pending_idx")
      .on(t.publishedAt)
      .where(sql`${t.eventProcessedAt} IS NULL`),
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

/** Intentos de login fallidos por IP, para el rate limit del auth compartido. */
export const authAttempts = sqliteTable("auth_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: integer("window_start").notNull(),
});

/**
 * Evento estructurado extraido de una o mas noticias. Es el objeto analitico
 * central del motor de inteligencia: varias noticias sobre lo mismo (Reuters,
 * Bloomberg, CNBC...) se agrupan en UN evento con varias evidencias, en vez de
 * generar una alerta por titular.
 *
 * Separa estrictamente HECHO (fact) de INFERENCIA (inference) y de la
 * EVALUACION de la IA (assessment). Toda conclusion queda trazable a las
 * noticias fuente via event_sources.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    /** Tipo de la taxonomia (ver EVENT_TYPES en src/lib/intel/types.ts). */
    type: text("type").notNull(),
    primaryAssetId: text("primary_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /** JSON array de symbols afectados. */
    companies: text("companies").notNull().default("[]"),
    headline: text("headline").notNull(),
    /** HECHO: lo que reportan las fuentes, sin interpretar. */
    fact: text("fact").notNull(),
    /** INFERENCIA: implicaciones probables, marcadas como tales. */
    inference: text("inference").notNull().default(""),
    /** EVALUACION IA: efecto sobre la tesis de inversion. */
    assessment: text("assessment").notNull().default(""),
    /** 0..100 */
    materiality: integer("materiality").notNull(),
    /** 0..100 */
    confidence: integer("confidence").notNull(),
    /** -100..100: cuanto cambia la tesis (no es sentimiento). */
    thesisImpact: integer("thesis_impact").notNull(),
    /** immediate | short | medium | long */
    timeHorizon: text("time_horizon").notNull(),
    /** 0..100, segun peso en cartera / watchlist. */
    portfolioRelevance: integer("portfolio_relevance").notNull(),
    /** 1 (evidencia primaria) .. 4 (fuente debil). Mejor tier entre fuentes. */
    sourceTier: integer("source_tier").notNull(),
    /** 0..100, ranking final. */
    signalScore: real("signal_score").notNull(),
    /** P1 (critico) .. P5 (ruido, no notificar). */
    priority: text("priority").notNull(),
    /** Fecha del evento (la noticia mas antigua del cluster). */
    occurredAt: integer("occurred_at").notNull(),
    /** Clave de deduplicacion del cluster de noticias. */
    clusterKey: text("cluster_key").notNull(),
    /** Auditoria: modelo y version del prompt que lo produjo. */
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** useful | not_useful | known | speculative | late | irrelevant */
    feedback: text("feedback"),
    feedbackAt: integer("feedback_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("events_cluster_idx").on(t.clusterKey),
    index("events_priority_idx").on(t.priority, t.signalScore),
    index("events_asset_idx").on(t.primaryAssetId),
    index("events_occurred_idx").on(t.occurredAt),
  ],
);

/** Evidencia: que noticias respaldan cada evento. */
export const eventSources = sqliteTable(
  "event_sources",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    newsId: text("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.newsId] })],
);

export type Asset = typeof assets.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type PriceRow = typeof priceCache.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
export type NewsRow = typeof news.$inferSelect;
export type Thesis = typeof theses.$inferSelect;
