CREATE TABLE `event_sources` (
	`event_id` text NOT NULL,
	`news_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `news_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`news_id`) REFERENCES `news`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`primary_asset_id` text,
	`companies` text DEFAULT '[]' NOT NULL,
	`headline` text NOT NULL,
	`fact` text NOT NULL,
	`inference` text DEFAULT '' NOT NULL,
	`assessment` text DEFAULT '' NOT NULL,
	`materiality` integer NOT NULL,
	`confidence` integer NOT NULL,
	`thesis_impact` integer NOT NULL,
	`time_horizon` text NOT NULL,
	`portfolio_relevance` integer NOT NULL,
	`source_tier` integer NOT NULL,
	`signal_score` real NOT NULL,
	`priority` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`cluster_key` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`feedback` text,
	`feedback_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`primary_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_cluster_idx` ON `events` (`cluster_key`);--> statement-breakpoint
CREATE INDEX `events_priority_idx` ON `events` (`priority`,`signal_score`);--> statement-breakpoint
CREATE INDEX `events_asset_idx` ON `events` (`primary_asset_id`);--> statement-breakpoint
CREATE INDEX `events_occurred_idx` ON `events` (`occurred_at`);--> statement-breakpoint
ALTER TABLE `news` ADD `event_processed_at` integer;