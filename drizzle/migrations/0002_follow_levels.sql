ALTER TABLE `tickets` ADD `broadcast` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `role` text DEFAULT 'follower' NOT NULL;
