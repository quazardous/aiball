ALTER TABLE tickets ADD COLUMN postponed_until TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_postponed ON tickets(postponed_until);
