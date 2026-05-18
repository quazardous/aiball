-- #B.191: backfill — mark as seen every existing ping where the recipient
-- is a kind=human consumer AND the message author is also a kind=human
-- consumer. These are the "faux unread" rows generated before the
-- fanOutPings cross-human skip landed (see src/messages.ts:fanOutPings).
--
-- David: "faux unread" — posting as "david" from the web UI ended up
-- pinging the `human` Moderator consumer (david's other identity) and
-- surfaced his own posts as unread. On his snapshot at landing time
-- this cleared ~410 pings.

UPDATE pings
SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE seen_at IS NULL
  AND recipient IN (SELECT consumer_id FROM consumers WHERE kind = 'human')
  AND (
    ticket_id IN (
        SELECT id FROM _messages
        WHERE by_agent IN (SELECT consumer_id FROM consumers WHERE kind = 'human')
    )
    OR comment_id IN (
        SELECT id FROM _messages
        WHERE by_agent IN (SELECT consumer_id FROM consumers WHERE kind = 'human')
    )
  );
