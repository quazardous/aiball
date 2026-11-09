-- #4866 — each document's revision: the number of the `rev` sequence it took
-- the last time it changed. A document is a ticket (its thread, tags, payload,
-- tokens, and every consumer's state about it) or a consumer (its row, its
-- project subscriptions, its credit moves tied to no ticket). A replica
-- pulls the documents revised after its cursor, whole. Every document starts
-- revised once, tickets then consumers, so a replica from 0 gets them all.
CREATE TABLE `doc_revs` (
    `kind` TEXT NOT NULL,
    `key` TEXT NOT NULL,
    `rev` INTEGER NOT NULL,
    PRIMARY KEY (`kind`, `key`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_doc_revs_rev` ON `doc_revs` (`rev`);--> statement-breakpoint
INSERT INTO `doc_revs` (`kind`, `key`, `rev`)
SELECT 'ticket', CAST(`id` AS TEXT), ROW_NUMBER() OVER (ORDER BY `id`) FROM `tickets`;--> statement-breakpoint
INSERT INTO `doc_revs` (`kind`, `key`, `rev`)
SELECT 'consumer', `consumer_id`, (SELECT COUNT(*) FROM `tickets`) + ROW_NUMBER() OVER (ORDER BY `consumer_id`) FROM `consumers`;--> statement-breakpoint
INSERT INTO `sequences` (`name`, `next`)
SELECT 'rev', COALESCE((SELECT MAX(`rev`) + 1 FROM `doc_revs`), 1);
