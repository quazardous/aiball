-- #634 david `svzkpw` (go C) — per-project direct token-effort tally.
-- Parallel sink to ticket_token_usage : the Stop-hook captures each turn's
-- token usage and pushes it to the `active-ticket` marker target ; when no
-- marker is set (the user did a direct session without any ticket-scoped
-- MCP tool call), the tokens used to be lost. With this table, they are
-- attributed to the project itself via the loop's AIBALL_PROJECT env.
-- Project total cost = SUM(ticket_token_usage of project's tickets) +
-- SUM(project_token_usage of project).
CREATE TABLE project_token_usage (
    project TEXT PRIMARY KEY,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_w INTEGER NOT NULL DEFAULT 0,
    cache_r INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
