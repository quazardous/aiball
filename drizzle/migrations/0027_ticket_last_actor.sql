-- #374: denormalized "last actor" on a ticket — the consumer who took the
-- LAST action on it (post a comment, accept/reject a decision, close / reopen
-- / resolve / block). Drives the per-consumer `actionable` gate:
--   actionable-for-C  iff  last_actor != C  OR  C is the sole participant.
-- Replaces the comment-only `lastNonLifecycleAuthorByTicket` heuristic, which
-- ignored lifecycle/decide actions (a reopened bug stayed invisible — #305).
-- Both columns nullable; backfilled idempotently at boot (bootstrap()).
ALTER TABLE `tickets` ADD `last_actor` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `last_actor_at` text;
