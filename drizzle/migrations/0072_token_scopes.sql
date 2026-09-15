-- What an API key may do, and in which projects. JSON arrays; NULL scopes on a
-- signal key = ["signals"], what every key could do before. Plain ADD COLUMN,
-- nullable: no rebuild, existing rows keep NULL.
ALTER TABLE tokens ADD COLUMN scopes TEXT;
--> statement-breakpoint
ALTER TABLE tokens ADD COLUMN projects TEXT;
