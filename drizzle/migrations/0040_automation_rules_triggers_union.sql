-- #457 slice 1.1 corrective : `trigger` (singular) becomes `triggers`
-- (JSON array, union).
--
-- David `8r7crj` : "trigger doit pouvoir être une union" — one rule can
-- now fire for ANY listed trigger (his scenario "win tag at creation OR
-- added later" = one rule with `triggers: ["ticket_created",
-- "ticket_tagged"]`, not two). Slice 1.1 (`f66ee1e`) shipped the JS-side
-- change correctly but ALSO patched 0039 in-place. That patch silently
-- no-op'd on deploys that had already applied the slice-1 version of
-- 0039 (drizzle skips by idx, not by content hash) — so the live DB
-- ended up with the wrong shape (`trigger` singular column + an extra
-- `idx_automation_rules_trigger` index). This migration is the proper
-- corrective.
--
-- Table is empty by contract — slice 1 + 1.1 wired no caller — so we
-- DROP + CREATE rather than do the ALTER TABLE / RENAME COLUMN dance.
-- On a fresh install where 0039 already created the right shape (the
-- in-place patch IS the file content), this still works : we drop the
-- correct shape and recreate the correct shape, just paying a few
-- microseconds for the round-trip. Idempotent + safe.
DROP INDEX IF EXISTS idx_automation_rules_trigger;--> statement-breakpoint
DROP TABLE IF EXISTS automation_rules;--> statement-breakpoint
CREATE TABLE automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    triggers TEXT NOT NULL DEFAULT '[]',
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
CREATE INDEX idx_automation_rules_scope_consumer ON automation_rules(scope_consumer);
