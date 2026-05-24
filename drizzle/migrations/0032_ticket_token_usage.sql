-- #404: per-ticket token-effort tally. The claude-loop Stop-hook reads each
-- turn's `usage` from the Claude session transcript and pushes the delta,
-- attributed to the active ticket (the last ticket-scoped MCP call). Accumulated
-- here. Raw counts (the UI/MCP derive a cost estimate; cache_r is cheap ~0.1x).
-- Statistical by design (turn-level granularity, multi-ticket turns → active).
CREATE TABLE ticket_token_usage (
    ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_w INTEGER NOT NULL DEFAULT 0,
    cache_r INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
