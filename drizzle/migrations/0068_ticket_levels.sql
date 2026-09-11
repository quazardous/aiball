-- #2241 — ticket levels become task | milestone | roadmap (work → task,
-- steering → roadmap). SQLite cannot alter a CHECK constraint.
--
-- Done column by column, NEVER by rebuilding the table: five tables reference
-- tickets with ON DELETE CASCADE, and the migrator runs inside one transaction
-- with foreign_keys = ON, where PRAGMA foreign_keys = OFF is a no-op. Measured
-- on a copy of the live database: the temp-table swap from docs/MIGRATIONS.md
-- (DROP TABLE tickets) deleted every comment, subscription, tag, token-usage
-- row and parent link, and still passed integrity_check and foreign_key_check.
-- A rename under legacy_alter_table does not help either: with foreign_keys on,
-- SQLite rewrites the children's REFERENCES to the renamed table.
--
-- Renaming, adding and dropping a column never drops the table, so no cascade
-- can fire. The old column's CHECK goes away with it.
ALTER TABLE tickets RENAME COLUMN level TO level_old;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN level TEXT NOT NULL DEFAULT 'task'
    CHECK (level IN ('task', 'milestone', 'roadmap'));--> statement-breakpoint
UPDATE tickets SET level = CASE level_old WHEN 'steering' THEN 'roadmap' ELSE 'task' END;--> statement-breakpoint
ALTER TABLE tickets DROP COLUMN level_old;
