CREATE TABLE `insider_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text,
	`cik` text NOT NULL,
	`symbol` text NOT NULL,
	`accession` text NOT NULL,
	`tx_index` integer NOT NULL,
	`owner_name` text NOT NULL,
	`owner_role` text NOT NULL,
	`officer_title` text,
	`code` text NOT NULL,
	`acquired` integer NOT NULL,
	`shares` real NOT NULL,
	`price` real,
	`value` real,
	`post_shares` real,
	`planned` integer DEFAULT false NOT NULL,
	`transaction_at` integer NOT NULL,
	`filed_at` integer NOT NULL,
	`url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insider_tx_accession_idx` ON `insider_transactions` (`accession`,`tx_index`);--> statement-breakpoint
CREATE INDEX `insider_tx_symbol_idx` ON `insider_transactions` (`symbol`,`transaction_at`);