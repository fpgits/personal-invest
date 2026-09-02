CREATE TABLE `fundamentals` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`earnings` text DEFAULT '[]' NOT NULL,
	`next_earnings_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thesis_assumptions` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`metric` text NOT NULL,
	`statement` text NOT NULL,
	`target` real,
	`comparator` text,
	`unit` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `theses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thesis_assumptions_thesis_idx` ON `thesis_assumptions` (`thesis_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `thesis_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`event_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`thesis_id`) REFERENCES `theses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `thesis_changes_thesis_idx` ON `thesis_changes` (`thesis_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `thesis_changes_status_idx` ON `thesis_changes` (`status`);--> statement-breakpoint
ALTER TABLE `assets` ADD `cik` text;--> statement-breakpoint
ALTER TABLE `news` ADD `kind` text DEFAULT 'news' NOT NULL;--> statement-breakpoint
ALTER TABLE `news` ADD `body` text;--> statement-breakpoint
ALTER TABLE `theses` ADD `structure` text;