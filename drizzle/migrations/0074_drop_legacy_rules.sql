-- #2697 — the legacy moderation rules table. Moderation reads automation rules
-- (trigger message_posted, action decision) since the engine was unified; this
-- table was still written by /api/rules and never read. No foreign key points
-- at it (checked on the live database, 17/09: 0 rows, no references).
DROP INDEX IF EXISTS `idx_rules_position`;--> statement-breakpoint
DROP TABLE IF EXISTS `rules`;
