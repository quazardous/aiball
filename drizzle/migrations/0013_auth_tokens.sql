-- Auth tokens + password storage on consumers (#B.94).
--
-- Adds a `tokens` table that handles three kinds of bearer tokens via
-- the same surface:
--   - kind='install' → one-shot, used to bootstrap the first human
--     consumer via the web /setup form. Consumed (deleted) on use.
--   - kind='auth'    → long-lived, issued by /setup or /login when
--     login+password verifies. Stored client-side and sent as
--     Authorization: Bearer on every /api/* call.
--   - kind='agent'   → long-lived, issued via `aiball token issue` for
--     non-interactive consumers (CLI, MCP servers, sandboxes).
--
-- The `consumer_id` on an install token may be NULL (no consumer yet,
-- the setup will create one). For auth + agent kinds, FK to consumers
-- with ON DELETE CASCADE.
--
-- Consumers gain `password_hash`. NULL for agents (never log in).

CREATE TABLE tokens (
    token TEXT PRIMARY KEY,
    consumer_id TEXT REFERENCES consumers(consumer_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('install', 'auth', 'agent')),
    label TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT
);--> statement-breakpoint

CREATE INDEX idx_tokens_consumer ON tokens(consumer_id);--> statement-breakpoint
CREATE INDEX idx_tokens_kind ON tokens(kind);--> statement-breakpoint

ALTER TABLE consumers ADD COLUMN password_hash TEXT;--> statement-breakpoint
ALTER TABLE consumers ADD COLUMN last_login_at TEXT;
