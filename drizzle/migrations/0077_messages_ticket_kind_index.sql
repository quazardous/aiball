-- #3000 — reads like "my comments on these tickets" filter on `kind` AND a
-- list of `ticket_id`. With no statistics, SQLite picked the `kind` index and
-- walked every comment of the board (~20k rows) to answer about forty tickets:
-- ~27 ms per read, three such reads per backlog request, which every loop
-- sends several times a minute. A (ticket_id, kind) index answers both.
CREATE INDEX IF NOT EXISTS `idx_messages_ticket_kind` ON `_messages`(`ticket_id`, `kind`);
