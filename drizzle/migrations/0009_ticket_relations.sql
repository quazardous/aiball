-- Ticket-to-ticket cross-references rendered as lifecycle events on the
-- target thread (per #B.61 follow-up + #B.62). Two new kinds:
--
--   - `ticket_sub_added`   posted on the parent thread when a sub-ticket
--                          is created (parent_ticket_id set on insert).
--   - `ticket_referenced`  posted on the referenced thread when another
--                          ticket's body mentions it (`#B.NN`, `#NN` outside
--                          backticks).
--
-- Both carry `source_ticket_id` pointing at the source ticket so the UI
-- can render a clickable link. ON DELETE CASCADE on source so deleting
-- the source ticket also wipes the pseudo-comments it spawned.

ALTER TABLE _messages ADD COLUMN source_ticket_id INTEGER
    REFERENCES tickets(id) ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_messages_source ON _messages(source_ticket_id);--> statement-breakpoint

-- Backfill: for every existing sub-ticket, post a synthetic
-- `ticket_sub_added` row on its parent's thread.
--
-- Id allocation: window-function over the max of the message space.
-- display_seq: window over the max per-parent.

INSERT INTO _messages (id, ticket_id, display_seq, kind, body, by_agent, status, created_at, source_ticket_id)
SELECT
    (SELECT COALESCE(MAX(id), 0) FROM _messages) + ROW_NUMBER() OVER (ORDER BY t.id) AS id,
    t.parent_ticket_id AS ticket_id,
    COALESCE(
        (SELECT MAX(display_seq) FROM _messages m2 WHERE m2.ticket_id = t.parent_ticket_id),
        0
    ) + ROW_NUMBER() OVER (PARTITION BY t.parent_ticket_id ORDER BY t.id) AS display_seq,
    'ticket_sub_added' AS kind,
    '' AS body,
    t.by_agent,
    'approved' AS status,
    t.created_at,
    t.id AS source_ticket_id
FROM tickets t
WHERE t.parent_ticket_id IS NOT NULL;--> statement-breakpoint

-- Bump next_message_id so future inserts don't collide with the
-- backfilled rows.
UPDATE settings
   SET value = CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM _messages) AS TEXT)
 WHERE key = 'next_message_id';
