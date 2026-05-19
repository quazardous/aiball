-- #B.222 phase A: per-ticket priority hint (low / normal / high / urgent).
--
-- David framing (49dh42): "la priorité est juste à indiquer à claude pour
-- le moment via le mcp" — orthogonal to `intent` (ticket nature). Priority
-- is an urgency hint; intent is the kind (panic / request / question / fyi).
--
-- Default NORMAL on backfill so existing tickets sort identically (with
-- intent=panic still floating to top via the dedicated panic-first rule
-- in listPings). NOT NULL DEFAULT to avoid NULL ordering surprises in the
-- CASE sort. CHECK gates the enum at the SQL layer; the application also
-- validates but the constraint catches stray writes (drizzle update, raw
-- SQL, future migrations).
ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
--> statement-breakpoint

CREATE INDEX idx_tickets_priority ON tickets(priority);
