ALTER TABLE `_messages` ADD `hashid` text;--> statement-breakpoint
CREATE INDEX `idx_messages_hashid` ON `_messages` (`hashid`);
