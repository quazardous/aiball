-- #449: generic config overrides — the storage half of the unified config
-- manager. The SCHEMA (keys, scope, type, default, protected) lives in code
-- (src/config/schema.ts); this table only holds OVERRIDES of a schema key at a
-- given layer. Layered read (src/db/config-overrides.ts getConfig): a project
-- override wins over the global override wins over the schema default.
--
--   project   '' = the GLOBAL layer; otherwise the project name (project layer)
--   key       a schema key (e.g. 'tickets.default_priority')
--   value     JSON-encoded (so number / boolean / string / enum share one column)
--
-- `project=''` (never NULL) so the UNIQUE(project, key) index actually enforces
-- one override per (layer, key) — SQLite treats NULLs as distinct, which would
-- let duplicate global rows slip in.
--
-- Existing dedicated settings (strategy, upload-max-bytes, tags) keep their own
-- storage for now; this framework covers new schema-driven keys, with the old
-- ones migrating onto it incrementally (#449 plan — cohabitation, no big-bang).
CREATE TABLE config_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);--> statement-breakpoint
CREATE UNIQUE INDEX idx_config_overrides_uniq ON config_overrides(project, key);
