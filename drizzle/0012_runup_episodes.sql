CREATE TABLE `runup_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`kind` text NOT NULL,
	`trough_date` text NOT NULL,
	`trough_price` real NOT NULL,
	`peak_date` text NOT NULL,
	`peak_price` real NOT NULL,
	`gain_pct` real NOT NULL,
	`days` integer NOT NULL,
	`anchor_date` text NOT NULL,
	`lookback_date` text NOT NULL,
	`snapshot` text,
	`signals` text,
	`scanned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runup_episodes_key_idx` ON `runup_episodes` (`symbol`,`kind`,`anchor_date`);--> statement-breakpoint
CREATE INDEX `runup_episodes_symbol_idx` ON `runup_episodes` (`symbol`);