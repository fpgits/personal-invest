CREATE TABLE `cusip_map` (
	`cusip` text PRIMARY KEY NOT NULL,
	`ticker` text,
	`name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manager_filings` (
	`id` text PRIMARY KEY NOT NULL,
	`manager_id` text NOT NULL,
	`accession` text NOT NULL,
	`period` text NOT NULL,
	`filed_at` integer NOT NULL,
	`total_value` real NOT NULL,
	`positions` integer NOT NULL,
	`url` text NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_filings_accession_idx` ON `manager_filings` (`manager_id`,`accession`);--> statement-breakpoint
CREATE INDEX `manager_filings_manager_idx` ON `manager_filings` (`manager_id`,`period`);--> statement-breakpoint
CREATE TABLE `manager_holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`filing_id` text NOT NULL,
	`cusip` text NOT NULL,
	`issuer` text NOT NULL,
	`ticker` text,
	`shares` real NOT NULL,
	`value` real NOT NULL,
	`pct` real NOT NULL,
	FOREIGN KEY (`filing_id`) REFERENCES `manager_filings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_holdings_filing_cusip_idx` ON `manager_holdings` (`filing_id`,`cusip`);--> statement-breakpoint
CREATE TABLE `managers` (
	`id` text PRIMARY KEY NOT NULL,
	`cik` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managers_cik_idx` ON `managers` (`cik`);