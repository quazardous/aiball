-- #393 (Option A): per-consumer project, pushed by claude-loop's state
-- heartbeat alongside `cwd`. Lets the daemon attribute a loop's root to
-- EXACTLY its project (root↔project), instead of the broad authored-content
-- heuristic that over-tags every project the consumer ever posted on.
ALTER TABLE consumers ADD COLUMN project TEXT;
