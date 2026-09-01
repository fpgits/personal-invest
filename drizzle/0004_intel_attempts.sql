ALTER TABLE `news` ADD `event_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `news_event_pending_idx` ON `news` (`published_at`) WHERE "news"."event_processed_at" IS NULL;