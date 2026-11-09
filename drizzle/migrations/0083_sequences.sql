-- #4866 — the board's numbers come from a dedicated sequence object: one row per
-- sequence (its next number), and the ranges reserved to nodes, which a
-- sequence's next number must never fall in. The counters move out of
-- `settings` as they are, with no jump.
CREATE TABLE `sequences` (
    `name` TEXT PRIMARY KEY NOT NULL,
    `next` INTEGER NOT NULL
);--> statement-breakpoint
INSERT INTO `sequences` (`name`, `next`)
SELECT 'ticket', COALESCE(
    (SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'next_ticket_id'),
    (SELECT MAX(`id`) + 1 FROM `tickets`),
    1);--> statement-breakpoint
INSERT INTO `sequences` (`name`, `next`)
SELECT 'message', COALESCE(
    (SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'next_message_id'),
    (SELECT MAX(`id`) + 1 FROM `_messages`),
    1000000);--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('next_ticket_id', 'next_message_id');--> statement-breakpoint
CREATE TABLE `sequence_ranges` (
    `sequence` TEXT NOT NULL,
    `start` INTEGER NOT NULL,
    `end` INTEGER NOT NULL,
    `owner` TEXT NOT NULL,
    `created_at` TEXT NOT NULL,
    PRIMARY KEY (`sequence`, `start`)
);
