-- #2255 — external signals: a synthetic wake from a system outside the board,
-- never a ticket.
--
-- 1. `tokens` gains the kind `signal`: an API key that opens POST /api/signals
--    and nothing else. SQLite cannot alter a CHECK, so the table is rebuilt —
--    safe HERE because no table references `tokens` (it is only a child of
--    consumers), so dropping it cascades to nothing. Checked with
--    pragma_foreign_key_list before writing this; see docs/MIGRATIONS.md.
CREATE TABLE tokens_new (
    token TEXT PRIMARY KEY,
    consumer_id TEXT REFERENCES consumers(consumer_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('install', 'auth', 'agent', 'node', 'signal')),
    label TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    last_seen_ip TEXT,
    display_host TEXT,
    display_host_provider TEXT
);--> statement-breakpoint
INSERT INTO tokens_new (token, consumer_id, kind, label, created_at, last_used_at, expires_at, last_seen_ip, display_host, display_host_provider)
    SELECT token, consumer_id, kind, label, created_at, last_used_at, expires_at, last_seen_ip, display_host, display_host_provider FROM tokens;--> statement-breakpoint
DROP TABLE tokens;--> statement-breakpoint
ALTER TABLE tokens_new RENAME TO tokens;--> statement-breakpoint
CREATE INDEX idx_tokens_consumer ON tokens(consumer_id);--> statement-breakpoint
CREATE INDEX idx_tokens_kind ON tokens(kind);--> statement-breakpoint
-- 2. The signals themselves, and who each one is for. A signal targets one
--    agent, or the owners of a project who work on a given level.
CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target_consumer TEXT,
    target_project TEXT,
    target_level TEXT CHECK (target_level IS NULL OR target_level IN ('task', 'milestone', 'roadmap')),
    title TEXT NOT NULL,
    body TEXT,
    severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal', 'panic')),
    dedup_key TEXT,
    repeat_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK ((target_consumer IS NULL) <> (target_project IS NULL)),
    CHECK (target_project IS NULL OR target_level IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX idx_signals_dedup ON signals(source, dedup_key);--> statement-breakpoint
CREATE TABLE signal_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    acked_at TEXT
);--> statement-breakpoint
CREATE UNIQUE INDEX idx_signal_deliveries_pair ON signal_deliveries(signal_id, recipient);--> statement-breakpoint
CREATE INDEX idx_signal_deliveries_recipient ON signal_deliveries(recipient, acked_at);
