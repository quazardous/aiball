-- #3008 — two indexes for the projects list, rebuilt at least every 5 s and
-- after every write. Both aggregates walked the whole `_messages` table:
--
-- * per project, the comment count, last activity and pending comments: a
--   covering index answers it from the index alone (~50 → ~18 ms measured on a
--   copy of a live base);
-- * the tickets with a resolution awaiting its reporter: a partial index over
--   the approved comments whose meta names a pending resolution (~44 → ~7 ms).
--   Its WHERE is the query's own prefilter, word for word, which is what lets
--   SQLite pick it; the JSON parse in the code still decides.
CREATE INDEX IF NOT EXISTS `idx_messages_ticket_kind_status_at` ON `_messages`(`ticket_id`, `kind`, `status`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_pending_resolution` ON `_messages`(`kind`, `status`)
 WHERE `kind` = 'comment_added' AND `status` = 'approved'
   AND `meta` LIKE '%"resolution"%' AND `meta` LIKE '%"pending"%';
