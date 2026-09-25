-- #3014 — comment ids start at 1 000 000, above every ticket id. 0007 split the
-- two counters and set the comments' one to MAX(id)+1 of `_messages`: right on
-- the base it renumbered (its comments had just moved above 1 000 000), wrong
-- on a new one, where it starts at 1 like the tickets' — comment 12 and ticket
-- #12 then share an id, and `/api/messages/:id` acts on the ticket. Raise it,
-- never lower it: a base already above keeps its counter.
UPDATE `settings` SET `value` = '1000000'
 WHERE `key` = 'next_message_id' AND CAST(`value` AS INTEGER) < 1000000;--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`)
SELECT 'next_message_id', '1000000'
 WHERE NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'next_message_id');
