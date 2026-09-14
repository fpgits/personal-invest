CREATE TABLE `universe_companies` (
	`cik` text PRIMARY KEY NOT NULL,
	`ticker` text,
	`name` text NOT NULL,
	`sic` text,
	`years` text NOT NULL,
	`shares_out` real,
	`cov_years` integer NOT NULL,
	`cov_concepts` integer NOT NULL,
	`cov_last_fy` integer,
	`usable` integer NOT NULL,
	`source_date` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `universe_ticker_idx` ON `universe_companies` (`ticker`);--> statement-breakpoint
CREATE INDEX `universe_usable_idx` ON `universe_companies` (`usable`);--> statement-breakpoint
CREATE TABLE `universe_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_date` text NOT NULL,
	`seen` integer NOT NULL,
	`parsed` integer NOT NULL,
	`usable` integer NOT NULL,
	`seconds` real NOT NULL,
	`note` text,
	`at` integer NOT NULL
);
