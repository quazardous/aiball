CREATE TABLE `_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`ticket_id` integer NOT NULL,
	`display_seq` integer NOT NULL,
	`kind` text NOT NULL,
	`parent_message_id` integer,
	`body` text,
	`by_agent` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`matched_rule_id` integer,
	`human_note` text,
	`edited_body` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_ticket_display` ON `_messages` (`ticket_id`,`display_seq`);--> statement-breakpoint
CREATE INDEX `idx_messages_ticket` ON `_messages` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_kind` ON `_messages` (`kind`);--> statement-breakpoint
CREATE TABLE `pings` (
	`recipient` text NOT NULL,
	`message_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`seen_at` text,
	PRIMARY KEY(`recipient`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pings_recipient_unread` ON `pings` (`recipient`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`match_project` text,
	`match_kind` text,
	`match_by_agent` text,
	`decision` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rules_position` ON `rules` (`position`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`consumer_id` text NOT NULL,
	`project` text NOT NULL,
	`subscribed_at` text NOT NULL,
	`last_seen_id` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`consumer_id`, `project`)
);
--> statement-breakpoint
CREATE INDEX `idx_subscriptions_project` ON `subscriptions` (`project`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`position` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE INDEX `idx_tags_position` ON `tags` (`position`);--> statement-breakpoint
CREATE TABLE `ticket_subscriptions` (
	`consumer_id` text NOT NULL,
	`ticket_id` integer NOT NULL,
	`subscribed_at` text NOT NULL,
	PRIMARY KEY(`consumer_id`, `ticket_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_subs_ticket` ON `ticket_subscriptions` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_tags` (
	`ticket_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`set_at` text NOT NULL,
	`set_by` text,
	PRIMARY KEY(`ticket_id`, `tag_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_tags_tag` ON `ticket_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`display_seq` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`by_agent` text,
	`priority` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`matched_rule_id` integer,
	`human_note` text,
	`edited_title` text,
	`edited_body` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tickets_project_display` ON `tickets` (`project`,`display_seq`);--> statement-breakpoint
CREATE INDEX `idx_tickets_project` ON `tickets` (`project`);--> statement-breakpoint
CREATE INDEX `idx_tickets_status` ON `tickets` (`status`);