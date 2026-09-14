CREATE TABLE `universe_coins` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`rank` integer,
	`price` real,
	`market_cap` real,
	`volume_24h` real,
	`ath` real,
	`drawdown_pct` real,
	`ath_days_ago` integer,
	`turnover_pct` real,
	`held` integer NOT NULL,
	`usable` integer NOT NULL,
	`reason` text,
	`source_date` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `universe_coins_symbol_idx` ON `universe_coins` (`symbol`);--> statement-breakpoint
CREATE INDEX `universe_coins_usable_idx` ON `universe_coins` (`usable`);