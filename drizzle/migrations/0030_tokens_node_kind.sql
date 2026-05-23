-- #394 volet C: allow kind='node' — a trusted-proxy SERVICE token (consumer_id
-- null) that lets a proxy node assert relayed identities via x-aiball-consumer
-- (X-Forwarded-For style). SQLite can't ALTER a CHECK constraint, so rebuild
-- the tokens table with the widened CHECK. Nothing references `tokens`, so no
-- foreign_keys PRAGMA dance is needed.
CREATE TABLE tokens_new (
    token TEXT PRIMARY KEY,
    consumer_id TEXT REFERENCES consumers(consumer_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('install', 'auth', 'agent', 'node')),
    label TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT
);--> statement-breakpoint
INSERT INTO tokens_new (token, consumer_id, kind, label, created_at, last_used_at, expires_at)
    SELECT token, consumer_id, kind, label, created_at, last_used_at, expires_at FROM tokens;--> statement-breakpoint
DROP TABLE tokens;--> statement-breakpoint
ALTER TABLE tokens_new RENAME TO tokens;--> statement-breakpoint
CREATE INDEX idx_tokens_consumer ON tokens(consumer_id);--> statement-breakpoint
CREATE INDEX idx_tokens_kind ON tokens(kind);
