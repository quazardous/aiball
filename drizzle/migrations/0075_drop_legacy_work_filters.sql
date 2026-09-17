-- #2718 — the legacy per-agent work filters table. The actionable gate reads
-- automation rules (trigger actionable_eval, action pickup) instead; this table
-- was still written by /api/work-filters and never read. No foreign key points
-- at it (checked on the live database, 17/09: 0 rows, no references).
DROP INDEX IF EXISTS `idx_work_filters_consumer`;--> statement-breakpoint
DROP TABLE IF EXISTS `work_filters`;
