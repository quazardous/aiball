-- #2216 — a ticket's level, orthogonal to intent (a steering ticket can be a
-- question) the way priority is. `work` is every ticket that existed before;
-- `steering` is a steering ticket: still readable by anyone, but kept out of the
-- backlog and the notifications of agents of type `coder`, owners included.
-- Ordinal on purpose: a level above is one more value, not a redesign.
ALTER TABLE tickets ADD COLUMN level TEXT NOT NULL DEFAULT 'work'
    CHECK (level IN ('work', 'steering'));
