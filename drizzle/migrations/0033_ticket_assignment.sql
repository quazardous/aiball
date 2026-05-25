-- #418: ticket → agent assignment + claim. Anti-collision for multi-agent.
-- One model, two ways in: a human moderator *pushes* an assignment
-- (assignee = someone, is_claim = 0), or an agent *claims* it for itself
-- (assignee = self, is_claim = 1). `assigned_by` audits who set it (the human
-- for a push, the agent for a claim). `assigned_at` stamps the moment; the live
-- window is DERIVED (now - assigned_at < assign_window_sec) — no stored
-- `assigned_until`, same pattern as `hot`, so a config change to the window
-- applies uniformly to live assignments. Auto-cleared on close/resolve.
ALTER TABLE tickets ADD COLUMN assignee TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN assigned_by TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN assigned_at TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN is_claim INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
