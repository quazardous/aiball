-- A free-text note on a token: for a signal key, who it was given to and why.
-- Plain ADD COLUMN, nullable: no rebuild, existing rows keep NULL.
ALTER TABLE tokens ADD COLUMN note TEXT;
