CREATE TABLE `conviction_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`asset_id` text,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`posture` text NOT NULL,
	`score` real NOT NULL,
	`confidence` real NOT NULL,
	`price` real,
	`fair_value` real,
	`upside_pct` real,
	`margin_of_safety_pct` real,
	`plan_amount` real,
	`rationale` text,
	`called_at` integer NOT NULL,
	`ret_30` real,
	`ret_90` real,
	`ret_180` real,
	`ret_365` real,
	`marked_at` integer
);
--> statement-breakpoint
CREATE INDEX `conviction_calls_symbol_idx` ON `conviction_calls` (`symbol`);--> statement-breakpoint
CREATE INDEX `conviction_calls_called_idx` ON `conviction_calls` (`called_at`);--> statement-breakpoint
CREATE INDEX `conviction_calls_batch_idx` ON `conviction_calls` (`batch_id`);