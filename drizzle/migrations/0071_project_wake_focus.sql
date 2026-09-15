-- A project's wake focus: which of its tickets may wake its owner agents, for
-- now. JSON {"tickets": "123, 456" | "!789", "until": ISO | null}; NULL = no focus.
-- Plain ADD COLUMN, nullable: no rebuild, existing rows keep NULL.
ALTER TABLE projects ADD COLUMN wake_focus TEXT;
