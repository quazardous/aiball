-- #1566 — watch a coupled issue WITHOUT duplicating it.
--
-- David's framing: the point is to COUPLE an issue to a ticket, not to mirror
-- its content. So nothing here stores title, body, labels or comments. The
-- probe only needs to answer "did anything change over there, and is the link
-- still healthy" — which is three scalars.
--
--   upstream_seen_at     the remote's own `updated_at` as last observed. THE
--                        watermark: probe finds a newer one → something moved.
--                        Also advanced by an outgoing push, so our own writes
--                        never echo back as "updated upstream".
--   upstream_checked_at  last ATTEMPT, success or not. Read against
--                        `upstream_synced_at` (last SUCCESS, already present
--                        since 0053): a widening gap is how a silently broken
--                        link becomes visible.
--   upstream_error       last failure message, NULL once a probe succeeds.
ALTER TABLE `tickets` ADD COLUMN `upstream_seen_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `upstream_checked_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `upstream_error` text;
