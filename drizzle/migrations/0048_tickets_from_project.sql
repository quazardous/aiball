-- #697 F4 (pisynth-claude #692) — cross-project ticket addressing made
-- first-class. Today a ticket like #691 lives in `pisynth` (the target
-- project where the recipient agent works) even though it was OPENED by
-- `kodi_sauvagge-claude` from a different project ; the routing is
-- implicit via soft relations and there's no signal to lens "tickets
-- addressed to me from another project" vs "tickets opened in my own
-- project". Add the explicit origin field so it's visible (UI chip,
-- ticket_list filter).
--
-- Nullable : the vast majority of tickets stay intra-project (from_project
-- == project), the column is set ONLY when the agent opening the ticket
-- intends a cross-project ask. No backfill — existing tickets stay
-- "intra-project" (from_project NULL means same as project).

ALTER TABLE tickets ADD COLUMN from_project TEXT;
