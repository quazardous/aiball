-- #2640 — the wait credit: minutes an agent earns by proof of work (a ticket
-- closed on its accepted resolution or wontfix, a commit it posted) and spends
-- on `continue_after_minutes`. One row per movement; the balance is the
-- configured start plus their sum, per agent x project.
CREATE TABLE wait_credit_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consumer_id TEXT NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    ticket_id INTEGER,
    message_id INTEGER,
    ref TEXT,
    requested INTEGER,
    created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_wait_credit_owner ON wait_credit_moves (consumer_id, project);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wait_credit_ticket_once ON wait_credit_moves (kind, consumer_id, project, ticket_id) WHERE kind IN ('earn_resolved', 'earn_wontfix');
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wait_credit_message_once ON wait_credit_moves (kind, message_id) WHERE kind IN ('spend', 'refund');
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wait_credit_commit_once ON wait_credit_moves (kind, ref) WHERE kind = 'earn_commit';
