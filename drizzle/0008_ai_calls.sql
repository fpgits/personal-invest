CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`cost_source` text DEFAULT 'none' NOT NULL,
	`ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_calls_purpose_idx` ON `ai_calls` (`purpose`,`created_at`);