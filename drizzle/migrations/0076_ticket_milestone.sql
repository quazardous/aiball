-- #2910 — a ticket belongs to at most one milestone: a ticket of level
-- `milestone` in the same project. Nullable, no backfill: every existing ticket
-- belongs to none. ON DELETE SET NULL: a deleted milestone frees its tickets.
ALTER TABLE `tickets` ADD COLUMN `milestone_id` INTEGER REFERENCES `tickets`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tickets_milestone` ON `tickets`(`milestone_id`);
