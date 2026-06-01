-- #697 F2 — restore the (recipient, target) unique index lost in migration
-- 0007 when `pings.message_id` was split into ticket_id + comment_id.
-- Without it, `INSERT … ON CONFLICT DO NOTHING` had no conflict target so
-- every insertPing call created a duplicate row. The "unread re-surface"
-- friction pisynth-claude #692 reported is the visible side-effect : the
-- fan-out paths (insertion + auto-approval + mentions + notifyDecision)
-- each inserted their own row for the same (recipient, message), and
-- markPingsRead only acked the rows present at the moment of the call —
-- subsequent inserts (or pre-existing duplicates) resurfaced.
--
-- SQLite treats NULL as DISTINCT in unique constraints, so a flat
-- UNIQUE(recipient, ticket_id, comment_id) wouldn't actually dedupe
-- (ticket_id=NULL on comment rows means many rows look "different").
-- Use COALESCE in the index expression : NULL collapses to 0 for the
-- comparison, and the existing CHECK already guarantees exactly one of
-- the two columns is non-null per row, so the (recipient, ticket_id, 0)
-- and (recipient, 0, comment_id) keyspaces never collide.

-- 1) Dedupe any existing duplicate rows. Keep the OLDEST (smallest
--    created_at, then smallest rowid as deterministic tiebreaker) since
--    that's the row earlier mark_read calls would have acked. The CHECK
--    constraint means COALESCE(ticket_id, 0) + COALESCE(comment_id, 0)
--    uniquely identifies the target.
DELETE FROM pings
WHERE rowid NOT IN (
    SELECT MIN(rowid)
    FROM pings
    GROUP BY recipient, COALESCE(ticket_id, 0), COALESCE(comment_id, 0)
);--> statement-breakpoint

-- 2) Add the unique index so insertPing's ON CONFLICT DO NOTHING finally
--    has something to conflict on.
CREATE UNIQUE INDEX idx_pings_recipient_target_unique
    ON pings(recipient, COALESCE(ticket_id, 0), COALESCE(comment_id, 0));
