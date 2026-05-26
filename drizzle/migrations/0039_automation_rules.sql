-- #457 — unified automation engine (event-driven rule engine).
--
-- Single table for ALL automation rules : moderation (replaces `rules`),
-- work-filters (replaces `work_filters`), AND new triggers (ticket_created,
-- ticket_tagged, …) with new actions (assign_to, add_tag, …). The pre-existing
-- `rules` and `work_filters` tables stay around for the slice-3 migration that
-- moves their rows here and switches the callers to this unified engine.
--
-- Shape (extensible — new triggers/actions don't change the schema) :
--   trigger          TEXT   — lifecycle event firing the rule (see `Trigger`
--                             enum in src/db/automation.ts).
--   scope_consumer   TEXT   — NULL = global rule ; otherwise the consumer_id
--                             this rule applies to (work-filter case).
--   match_*          TEXT   — condition vocabulary, all optional (NULL = "any") :
--                             project / kind / by_agent / intent / priority +
--                             match_tags (JSON [] any-of) +
--                             match_tag_added (single tag, ticket_tagged only).
--   action_kind      TEXT   — discriminator : decision / pickup / assign /
--                             add_tag / set_priority / notify. New actions =
--                             new kind value, no schema change.
--   action_data      TEXT   — JSON payload typed by action_kind (e.g.
--                             { "consumer_id": "aiball-windows" } for assign).
--   position, enabled, note, created_at — same shape as `rules` /
--                             `work_filters` (first-match-wins for triggers
--                             that support it ; all-apply for the rest).
CREATE TABLE automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    trigger TEXT NOT NULL,
    scope_consumer TEXT,
    match_project TEXT,
    match_kind TEXT,
    match_by_agent TEXT,
    match_tags TEXT NOT NULL DEFAULT '[]',
    match_tag_added TEXT,
    match_intent TEXT,
    match_priority TEXT,
    action_kind TEXT NOT NULL,
    action_data TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL
);--> statement-breakpoint
CREATE INDEX idx_automation_rules_trigger ON automation_rules(trigger);--> statement-breakpoint
CREATE INDEX idx_automation_rules_scope_consumer ON automation_rules(scope_consumer);
