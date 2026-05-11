-- ====================================================================
-- Split pings.message_id (polymorphic) into pings.ticket_id +
-- pings.comment_id, then renumber tickets.id to be dense (1, 2, 3, …).
--
-- Why: before this migration, tickets and _messages shared a single
-- `nextGlobalId` counter (so pings.message_id could resolve to either
-- a ticket-root or a comment without ambiguity). The cost was that
-- `#B.NNN` numbers looked sparse to users — every comment + lifecycle
-- event consumed a slot in the sequence.
--
-- This migration splits the polymorphic pings column into two
-- explicit columns (exactly one set per row, enforced by CHECK), then
-- renumbers tickets to 1..N (chronological order preserved). Comments
-- (_messages) keep their existing ids — only ticket ids change.
--
-- Breaking change accepted: refs `#B.NNN` in already-posted bodies
-- that pointed to old (sparse) ticket ids now resolve to a different
-- ticket — or to nothing.
-- ====================================================================

PRAGMA defer_foreign_keys = ON;--> statement-breakpoint

-- --------------------------------------------------------------------
--  A. Split pings.message_id into ticket_id + comment_id
-- --------------------------------------------------------------------

ALTER TABLE pings ADD COLUMN ticket_id INTEGER;--> statement-breakpoint
ALTER TABLE pings ADD COLUMN comment_id INTEGER;--> statement-breakpoint

UPDATE pings
   SET ticket_id = message_id
 WHERE message_id IN (SELECT id FROM tickets);--> statement-breakpoint

UPDATE pings
   SET comment_id = message_id
 WHERE message_id IN (SELECT id FROM _messages);--> statement-breakpoint

-- --------------------------------------------------------------------
--  B. Renumber tickets.id to be sequential (1, 2, 3, …)
--
--  Two-step to avoid PK collisions: first shift every ticket-related
--  id by +1_000_000 so we have a free range, then build a mapping
--  from the shifted ids to the new sequential ids, then apply.
-- --------------------------------------------------------------------

UPDATE tickets SET id = id + 1000000;--> statement-breakpoint
UPDATE _messages SET ticket_id = ticket_id + 1000000;--> statement-breakpoint
UPDATE ticket_tags SET ticket_id = ticket_id + 1000000;--> statement-breakpoint
UPDATE ticket_subscriptions SET ticket_id = ticket_id + 1000000;--> statement-breakpoint
UPDATE pings SET ticket_id = ticket_id + 1000000 WHERE ticket_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE _ticket_id_map (
    offset_id INTEGER PRIMARY KEY,
    new_id INTEGER NOT NULL UNIQUE
);--> statement-breakpoint

INSERT INTO _ticket_id_map (offset_id, new_id)
SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM tickets;--> statement-breakpoint

UPDATE _messages
   SET ticket_id = (SELECT new_id FROM _ticket_id_map WHERE offset_id = _messages.ticket_id);--> statement-breakpoint

UPDATE ticket_tags
   SET ticket_id = (SELECT new_id FROM _ticket_id_map WHERE offset_id = ticket_tags.ticket_id);--> statement-breakpoint

UPDATE ticket_subscriptions
   SET ticket_id = (SELECT new_id FROM _ticket_id_map WHERE offset_id = ticket_subscriptions.ticket_id);--> statement-breakpoint

UPDATE pings
   SET ticket_id = (SELECT new_id FROM _ticket_id_map WHERE offset_id = pings.ticket_id)
 WHERE ticket_id IS NOT NULL;--> statement-breakpoint

UPDATE tickets
   SET id = (SELECT new_id FROM _ticket_id_map WHERE offset_id = tickets.id);--> statement-breakpoint

DROP TABLE _ticket_id_map;--> statement-breakpoint

-- --------------------------------------------------------------------
--  B2. Shift _messages.id (and the FK columns that point at it) by
--      a large offset so the comment id space NEVER overlaps with
--      the new dense ticket ids (1..N). Users don't see comment ids
--      (they see `#C.<hashid>`), so the value is irrelevant — only
--      uniqueness across the two spaces matters, so that
--      `pings.ticket_id` and `pings.comment_id` can never refer to
--      the same numeric value pointing at different rows.
-- --------------------------------------------------------------------

UPDATE _messages SET id = id + 1000000;--> statement-breakpoint
UPDATE _messages SET parent_message_id = parent_message_id + 1000000
 WHERE parent_message_id IS NOT NULL;--> statement-breakpoint
UPDATE pings SET comment_id = comment_id + 1000000
 WHERE comment_id IS NOT NULL;--> statement-breakpoint

-- --------------------------------------------------------------------
--  C. Drop pings.message_id (polymorphic, now obsolete). Rebuild
--     the table because the old PRIMARY KEY (recipient, message_id)
--     can't survive the column drop cleanly.
-- --------------------------------------------------------------------

CREATE TABLE pings_new (
    recipient TEXT NOT NULL,
    ticket_id INTEGER,
    comment_id INTEGER,
    created_at TEXT NOT NULL,
    seen_at TEXT,
    CHECK (
        (ticket_id IS NOT NULL AND comment_id IS NULL) OR
        (ticket_id IS NULL AND comment_id IS NOT NULL)
    )
);--> statement-breakpoint

INSERT INTO pings_new (recipient, ticket_id, comment_id, created_at, seen_at)
SELECT recipient, ticket_id, comment_id, created_at, seen_at FROM pings;--> statement-breakpoint

DROP TABLE pings;--> statement-breakpoint
ALTER TABLE pings_new RENAME TO pings;--> statement-breakpoint

-- Partial unique indexes per kind (ticket pings vs comment pings)
-- enforce "no duplicate ping for the same recipient on the same target".
CREATE UNIQUE INDEX idx_pings_recipient_ticket
    ON pings(recipient, ticket_id) WHERE ticket_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX idx_pings_recipient_comment
    ON pings(recipient, comment_id) WHERE comment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_pings_recipient_unread
    ON pings(recipient) WHERE seen_at IS NULL;--> statement-breakpoint

-- --------------------------------------------------------------------
--  D. Settings — drop the shared global counter, init separate
--     counters for tickets and messages.
-- --------------------------------------------------------------------

DELETE FROM settings WHERE key IN ('next_global_id', 'next_ticket_seq');--> statement-breakpoint

INSERT INTO settings (key, value)
VALUES ('next_ticket_id', CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM tickets) AS TEXT));--> statement-breakpoint

INSERT INTO settings (key, value)
VALUES ('next_message_id', CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM _messages) AS TEXT));
