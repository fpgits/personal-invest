import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Memoria de patrones: grandes subidas y maximos historicos del pasado con la
 * foto de fundamentales "tal como se conocian" seis meses antes. Es de donde
 * se aprende que precedio de verdad a un salto (GoPro, NVDA, BTC), sin mirar
 * cifras que entonces nadie tenia.
 *
 * Vive en su propio modulo, no en schema.ts, para que la tabla se pueda anadir
 * sin tocar el archivo grande. drizzle.config.ts incluye los dos archivos, asi
 * que `drizzle-kit generate` sigue viendo el esquema completo.
 */
export const runupEpisodes = sqliteTable(
  "runup_episodes",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    assetClass: text("asset_class").notNull(),
    /** runup | ath */
    kind: text("kind").notNull(),
    troughDate: text("trough_date").notNull(),
    troughPrice: real("trough_price").notNull(),
    peakDate: text("peak_date").notNull(),
    peakPrice: real("peak_price").notNull(),
    gainPct: real("gain_pct").notNull(),
    days: integer("days").notNull(),
    anchorDate: text("anchor_date").notNull(),
    lookbackDate: text("lookback_date").notNull(),
    /** JSON: Snapshot (bolsa) o CycleStats (cripto) a lookback_date. */
    snapshot: text("snapshot"),
    /** JSON: senales de filings conocidas a lookback_date. */
    signals: text("signals"),
    scannedAt: integer("scanned_at").notNull(),
  },
  (t) => [
    uniqueIndex("runup_episodes_key_idx").on(t.symbol, t.kind, t.anchorDate),
    index("runup_episodes_symbol_idx").on(t.symbol),
  ],
);

export type RunupEpisode = typeof runupEpisodes.$inferSelect;
