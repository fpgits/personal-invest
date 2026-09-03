CREATE TABLE `cash_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`occurred_at` integer NOT NULL,
	`external_id` text NOT NULL,
	`source` text DEFAULT 'sync' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_flows_account_external_idx` ON `cash_flows` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `cash_flows_occurred_idx` ON `cash_flows` (`occurred_at`);