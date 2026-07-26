-- #1565 — invert the edited/original convention.
--
-- Before: `title`/`body` held the ORIGINAL text and `edited_title`/`edited_body`
-- the current one, so every read site had to write `edited_x ?? x`. A site that
-- forgot the coalesce silently rendered stale text — and the FTS triggers, which
-- index `title`/`body`, indexed the original: `search()` could not find text an
-- edit had added, and still matched text an edit had removed.
--
-- After: `title`/`body` hold the CURRENT text (what every reader wants, plain)
-- and `original_*` keeps the pre-edit archive. NULL there means "never edited"
-- — it is not a systematic copy.
--
-- The UPDATEs below fire the `*_fts_au` triggers, so the full-text index is
-- rebuilt on the current text as a side effect. No trigger change needed.
ALTER TABLE `tickets` ADD COLUMN `original_title` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `original_body` text;--> statement-breakpoint
UPDATE `tickets` SET `original_title` = `title`, `title` = `edited_title` WHERE `edited_title` IS NOT NULL;--> statement-breakpoint
UPDATE `tickets` SET `original_body` = `body`, `body` = `edited_body` WHERE `edited_body` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` DROP COLUMN `edited_title`;--> statement-breakpoint
ALTER TABLE `tickets` DROP COLUMN `edited_body`;--> statement-breakpoint
ALTER TABLE `_messages` ADD COLUMN `original_body` text;--> statement-breakpoint
UPDATE `_messages` SET `original_body` = `body`, `body` = `edited_body` WHERE `edited_body` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `_messages` DROP COLUMN `edited_body`;
