CREATE VIRTUAL TABLE `tickets_fts` USING fts5(
    title,
    body,
    content='tickets',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
    body,
    content='_messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
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
