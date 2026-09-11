CREATE TABLE `powero_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`book` text NOT NULL,
	`at` integer NOT NULL,
	`cash` real NOT NULL,
	`positions_value` real NOT NULL,
	`equity` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `powero_marks_key_idx` ON `powero_marks` (`book`,`at`);--> statement-breakpoint
CREATE INDEX `powero_marks_at_idx` ON `powero_marks` (`at`);--> statement-breakpoint
CREATE TABLE `powero_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`book` text NOT NULL,
	`symbol` text NOT NULL,
	`asset_id` text,
	`side` text NOT NULL,
	`qty` real NOT NULL,
	`price` real NOT NULL,
	`amount` real NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`reason` text,
	`source` text NOT NULL,
	`proposed_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `powero_orders_book_idx` ON `powero_orders` (`book`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `powero_orders_status_idx` ON `powero_orders` (`status`);