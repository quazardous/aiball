-- Sub-tickets: nullable FK from tickets to tickets, so a ticket can have a
-- parent ticket. Used to split a large request (e.g. a multi-item CR like
-- #B.61) into actionable children while keeping the lineage explicit.
--
-- ON DELETE SET NULL — deleting a parent leaves the children as standalone
-- top-level tickets rather than cascading (kids may still be relevant).
-- ON DELETE CASCADE would mass-delete potentially live work.

ALTER TABLE tickets ADD COLUMN parent_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id);
