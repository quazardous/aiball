-- Upstream coupling (GitHub / GitLab), phase 2 — per-ticket link.
-- A ticket becomes "coupled" to an external issue by carrying these
-- columns. NULL = a pure aiball ticket the coupling driver never touches
-- (this is what preserves aiball-only tickets by construction). Coupling
-- is always an explicit, manual act (import / export); nothing here is
-- populated automatically.
--   upstream_kind      provider id, e.g. "github" (matches UpstreamProvider.id)
--   upstream_ref       provider ref string, e.g. "github:owner/repo"
--   upstream_num       external issue number
--   upstream_synced_at ISO8601 of the last successful sync (NULL until first)
ALTER TABLE tickets ADD COLUMN upstream_kind TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN upstream_ref TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN upstream_num INTEGER;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN upstream_synced_at TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_upstream ON tickets(upstream_kind, upstream_ref, upstream_num);
