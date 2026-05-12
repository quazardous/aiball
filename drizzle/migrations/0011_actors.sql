-- Actors table (#B.79). Replaces the hardcoded string `"human"` (and
-- the CSV $AIBALL_HUMAN env) used everywhere to identify the human
-- moderator. Every consumer_id seen by the daemon (post, ping, sub)
-- gets a row; the `kind` column says whether it's a human or an agent.
--
-- Backfill at the bottom: one row per distinct consumer_id we've ever
-- observed, defaulting to `agent`. The literal value `"human"` is
-- promoted to kind=human so the bypass that used to rely on a string
-- comparison keeps working without code changes after the migration
-- but before any UI tagging.

CREATE TABLE actors (
    consumer_id TEXT PRIMARY KEY,
    -- 'human' (moderator-class, gets bypass) or 'agent' (anyone else).
    kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('human', 'agent')),
    -- Free-form display label (e.g. "David", "Claude (aiball-dev)").
    -- Falls back to consumer_id when null.
    display_name TEXT,
    -- 1 = active; 0 = blocked (the daemon refuses posts from this
    -- consumer_id). 0 doesn't delete past content, just gates future
    -- writes.
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);--> statement-breakpoint

CREATE INDEX idx_actors_kind ON actors(kind);--> statement-breakpoint

-- Backfill from every place we've stored a consumer_id.
INSERT OR IGNORE INTO actors (consumer_id, kind, created_at, updated_at)
SELECT DISTINCT by_agent, 'agent', datetime('now'), datetime('now')
FROM tickets WHERE by_agent IS NOT NULL AND by_agent != '';--> statement-breakpoint

INSERT OR IGNORE INTO actors (consumer_id, kind, created_at, updated_at)
SELECT DISTINCT by_agent, 'agent', datetime('now'), datetime('now')
FROM _messages WHERE by_agent IS NOT NULL AND by_agent != '';--> statement-breakpoint

INSERT OR IGNORE INTO actors (consumer_id, kind, created_at, updated_at)
SELECT DISTINCT consumer_id, 'agent', datetime('now'), datetime('now')
FROM subscriptions WHERE consumer_id IS NOT NULL AND consumer_id != '';--> statement-breakpoint

INSERT OR IGNORE INTO actors (consumer_id, kind, created_at, updated_at)
SELECT DISTINCT recipient, 'agent', datetime('now'), datetime('now')
FROM pings WHERE recipient IS NOT NULL AND recipient != '';--> statement-breakpoint

-- Promote the literal "human" label to kind=human so the bypass that
-- existing code relies on (process.env.AIBALL_HUMAN ?? "human")
-- continues to match isHuman() lookups out of the box.
UPDATE actors SET kind = 'human' WHERE consumer_id = 'human';
