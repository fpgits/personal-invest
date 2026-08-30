CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`exchange_id` text,
	`api_key_enc` text,
	`api_secret_enc` text,
	`api_passphrase_enc` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `ai_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_messages_thread_idx` ON `ai_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'Nueva conversacion' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`asset_class` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`provider_id` text,
	`logo_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_symbol_class_idx` ON `assets` (`symbol`,`asset_class`);--> statement-breakpoint
CREATE INDEX `assets_class_idx` ON `assets` (`asset_class`);--> statement-breakpoint
CREATE TABLE `news` (
	`id` text PRIMARY KEY NOT NULL,
	`headline` text NOT NULL,
	`url` text NOT NULL,
	`source` text,
	`image_url` text,
	`published_at` integer NOT NULL,
	`summary` text,
	`sentiment` text,
	`impact` text,
	`tickers` text DEFAULT '[]' NOT NULL,
	`processed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_url_idx` ON `news` (`url`);--> statement-breakpoint
CREATE INDEX `news_published_idx` ON `news` (`published_at`);--> statement-breakpoint
CREATE TABLE `price_cache` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`price` real NOT NULL,
	`change_24h` real,
	`change_pct_24h` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`total_value` real NOT NULL,
	`cost_basis` real NOT NULL,
	`unrealized_pnl` real NOT NULL,
	`realized_pnl` real NOT NULL,
	`breakdown` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_date_idx` ON `snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_idx` ON `sync_runs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `theses` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`thesis` text NOT NULL,
	`conviction` integer,
	`target_price` real,
	`horizon` text,
	`generated_by` text DEFAULT 'manual' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theses_asset_idx` ON `theses` (`asset_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`type` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`executed_at` integer NOT NULL,
	`external_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tx_account_external_idx` ON `transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `tx_asset_idx` ON `transactions` (`asset_id`);--> statement-breakpoint
CREATE INDEX `tx_executed_idx` ON `transactions` (`executed_at`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`note` text,
	`target_price` real,
	`alert_direction` text,
	`added_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_asset_idx` ON `watchlist` (`asset_id`);