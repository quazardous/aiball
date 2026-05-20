-- #B.224 phase B: collapse the per-project strategy k/v hack onto a
-- proper column on the projects table, behind a typed SDK.
--
-- Background: until now per-project response strategy lived in the
-- settings k/v table under key `strategy:<project>` — that hack pre-
-- dated the explicit projects table (#B.216) and was always meant to
-- be temporary. David (#zad7hu): go straight to the SDK design rather
-- than a separate column-rebase pass first.
--
-- This migration is the storage layer for the new `src/preferences.ts`
-- ProjectPrefs SDK. Strategy is the first preference to land; future
-- per-project knobs (default_intent / default_priority / etc.) add
-- their own columns and SDK entries.
--
-- Idempotent backfill: `UPDATE ... SET col = (SELECT value FROM
-- settings WHERE ...)` is a no-op when the projects row predates a
-- k/v entry, and copies the strategy verbatim when both exist. Legacy
-- k/v rows deleted after the copy so future reads only go through
-- the typed column.
ALTER TABLE projects ADD COLUMN default_strategy TEXT
    CHECK (default_strategy IS NULL OR default_strategy IN ('manual', 'auto', 'auto-reply'));
--> statement-breakpoint

UPDATE projects SET default_strategy = (
    SELECT value FROM settings
    WHERE key = 'strategy:' || projects.name
);
--> statement-breakpoint

DELETE FROM settings WHERE key LIKE 'strategy:%';
