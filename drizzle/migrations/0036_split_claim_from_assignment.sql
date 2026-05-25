-- #436: separate ASSIGNMENT (responsibility, human-pushed, persistent, no
-- expiry) from CLAIM (focus, agent self-declared, transient/auto-expire,
-- one-focus). #418 fused them in `assignee` + `is_claim`, so claiming a ticket
-- overwrote any human assignment (you couldn't be assigned-to AND claimed at
-- once). Split into two field-sets so a ticket can be BOTH assigned to A and
-- claimed by A simultaneously — required for "assignment feeds the claimable
-- order" (#436 decision 4).
--
--   assignee / assigned_by / assigned_at  → assignment (kept)
--   claimant / claimed_at                 → claim (new)
--
-- Back-fill: existing self-claims (is_claim = 1) ARE claims, not assignments —
-- migrate them to claimant/claimed_at and clear their assignee triple. Human
-- assignments (is_claim = 0) stay as-is (claimant NULL).
--
-- `is_claim` is kept (vestigial): dropping a column needs a full table rebuild
-- in SQLite, and the new code derives claim-ness from `claimant` instead. A
-- later cleanup migration can drop it once nothing reads it.
ALTER TABLE tickets ADD COLUMN claimant TEXT;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN claimed_at TEXT;--> statement-breakpoint
UPDATE tickets
   SET claimant = assignee,
       claimed_at = assigned_at,
       assignee = NULL,
       assigned_at = NULL,
       assigned_by = NULL
 WHERE is_claim = 1 AND assignee IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_claimant ON tickets(claimant);
