CREATE TABLE IF NOT EXISTS token_usage_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_w INTEGER NOT NULL DEFAULT 0,
    cache_r INTEGER NOT NULL DEFAULT 0
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_snapshot_project_time ON token_usage_snapshot(project, captured_at);
