-- #3245 — the writes a client may send twice: a post whose answer was lost
-- (the daemon busy, the client's call timed out) goes to the client's spool,
-- and its replay created the message a second time. Each write carries a key
-- the client draws once; the daemon remembers it a week, and answers a key it
-- has seen with the message it made.
CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
);--> statement-breakpoint
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at);
