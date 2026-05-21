-- #285: switch FTS5 tokenizer unicode61 (whole-word) → trigram so the UI
-- search matches WORD FRAGMENTS (substring/infix), not just whole tokens.
-- `remove_diacritics 1` keeps the accent-insensitivity of migration 0004
-- (trigram is case-insensitive by default). FTS tables are external-content
-- (derived from tickets / _messages), so dropping + rebuilding them loses no
-- source data — the INSERT…SELECT below repopulates from the base tables.
DROP TRIGGER IF EXISTS `tickets_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tickets_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tickets_fts_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `messages_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `messages_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `messages_fts_au`;--> statement-breakpoint
DROP TABLE IF EXISTS `tickets_fts`;--> statement-breakpoint
DROP TABLE IF EXISTS `messages_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `tickets_fts` USING fts5(
    title,
    body,
    content='tickets',
    content_rowid='id',
    tokenize='trigram remove_diacritics 1'
);--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
    body,
    content='_messages',
    content_rowid='id',
    tokenize='trigram remove_diacritics 1'
);--> statement-breakpoint
INSERT INTO `tickets_fts` (rowid, title, body) SELECT id, title, body FROM `tickets`;--> statement-breakpoint
INSERT INTO `messages_fts` (rowid, body) SELECT id, body FROM `_messages`;--> statement-breakpoint
CREATE TRIGGER `tickets_fts_ai` AFTER INSERT ON `tickets` BEGIN
    INSERT INTO `tickets_fts` (rowid, title, body) VALUES (new.id, new.title, new.body);
END;--> statement-breakpoint
CREATE TRIGGER `tickets_fts_ad` AFTER DELETE ON `tickets` BEGIN
    INSERT INTO `tickets_fts` (`tickets_fts`, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;--> statement-breakpoint
CREATE TRIGGER `tickets_fts_au` AFTER UPDATE ON `tickets` BEGIN
    INSERT INTO `tickets_fts` (`tickets_fts`, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO `tickets_fts` (rowid, title, body) VALUES (new.id, new.title, new.body);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `_messages` BEGIN
    INSERT INTO `messages_fts` (rowid, body) VALUES (new.id, new.body);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `_messages` BEGIN
    INSERT INTO `messages_fts` (`messages_fts`, rowid, body) VALUES ('delete', old.id, old.body);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `_messages` BEGIN
    INSERT INTO `messages_fts` (`messages_fts`, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO `messages_fts` (rowid, body) VALUES (new.id, new.body);
END;
