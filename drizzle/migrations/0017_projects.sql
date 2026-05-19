-- #B.216 phase A pass 1: explicit projects table.
--
-- Until now a "project" existed implicitly via DISTINCT(tickets.project).
-- David needs a real registry so the CLI can `aiball project init` and
-- the Web UI can create a project before the first ticket. The table is
-- a soft registry: tickets.project stays a free TEXT column (no FK
-- constraint added), but listings + create endpoints will go through
-- this table starting in pass 2.
--
-- Backfill seeds one row per distinct project found in tickets, using
-- the earliest ticket as the implicit creation timestamp + author so
-- the registry doesn't look retroactively empty.
CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    display_name TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT
);--> statement-breakpoint

INSERT OR IGNORE INTO projects (name, created_at, created_by)
SELECT
    project,
    MIN(created_at)        AS created_at,
    -- by_agent of the EARLIEST ticket in the project; NULL when none
    -- had an author recorded.
    (SELECT t2.by_agent
     FROM tickets t2
     WHERE t2.project = t1.project
     ORDER BY t2.created_at ASC
     LIMIT 1)               AS created_by
FROM tickets t1
GROUP BY project;
