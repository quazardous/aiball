-- #447: per-agent "work filters" — narrow which tickets a consumer (agent)
-- actually picks up, by tag. e.g. "the aiball-windows agent only works tickets
-- tagged win". Stored in the daemon DB (NOT per-machine config) so a loop on
-- ANY machine that talks to this daemon sees the same filter — the linux and
-- windows loops share one daemon DB (proxy-relay or direct), which is exactly
-- what makes the cross-machine case work without syncing config files.
--
-- Applied server-side in the actionable/claimable gate: it narrows the agent's
-- engage/actionable pool, NEVER the human's view of the board.
--
--   consumer_id  → the agent constrained
--   project      → optional scope (NULL = all the consumer's projects)
--   mode         → 'only' (work ONLY tickets that match) | 'except' (never work
--                  tickets that match)
--   match_tags   → JSON array of tag names, any-of (a ticket "matches" when it
--                  carries at least one of them)
--   enabled      → mute toggle (0/1), mirrors the moderation `rules` table
CREATE TABLE work_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    consumer_id TEXT NOT NULL,
    project TEXT,
    mode TEXT NOT NULL DEFAULT 'only',
    match_tags TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL
);--> statement-breakpoint
CREATE INDEX idx_work_filters_consumer ON work_filters(consumer_id);
