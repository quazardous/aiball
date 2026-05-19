-- #B.245 phase A: per-message `internal` flag — when true, the
-- message bypasses normal subscriber fan-out. Only @mention recipients
-- ping, and @projet mentions only reach project owners (not followers).
-- Replaces the "replying as" composer affordance (#B.240 option 4).
--
-- Default 0 on backfill so existing rows behave identically. NOT NULL
-- to keep the fan-out branching binary. CHECK gates the enum at the
-- SQL layer; the application also validates.
ALTER TABLE _messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0
    CHECK (internal IN (0, 1));
