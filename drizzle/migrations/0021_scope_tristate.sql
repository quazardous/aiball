-- #B.245 — unify `tickets.broadcast` (bool) + `_messages.internal` (bool)
-- into a single tristate `scope` per david (#79h7zk):
--
--   internal  = owners-only + @mentions explicites
--   default   = ticket subscribers + project owners + @mentions
--   broadcast = + project followers
--
-- Both tables get the column (every event carries its own scope —
-- david: "c'est pas un attribut du ticket mais bien du commentaire").
-- ticket_created lives in `tickets` so it needs scope there; comments
-- live in `_messages` so it needs scope there too.
--
-- Backfill maps the prior booleans:
--   tickets.broadcast=1 → scope='broadcast'; else 'default'
--   _messages.internal=1 → scope='internal'; else 'default'
--
-- Then the old columns are dropped — arrachage propre per david
-- (#79h7zk implicit + plan #nxmeaj question 2). The internal column
-- only landed in 0020 a few minutes ago and was never committed;
-- broadcast had its own life but the rename is a clean shift since
-- `Message.broadcast` accessor stays as a derived view of `scope`.

ALTER TABLE tickets ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'
    CHECK (scope IN ('internal', 'default', 'broadcast'));
--> statement-breakpoint
UPDATE tickets SET scope = 'broadcast' WHERE broadcast = 1;
--> statement-breakpoint
ALTER TABLE tickets DROP COLUMN broadcast;
--> statement-breakpoint

ALTER TABLE _messages ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'
    CHECK (scope IN ('internal', 'default', 'broadcast'));
--> statement-breakpoint
UPDATE _messages SET scope = 'internal' WHERE internal = 1;
--> statement-breakpoint
ALTER TABLE _messages DROP COLUMN internal;
