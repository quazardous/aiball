-- Agent-authored short summary on tickets (#B.87 comment from human).
--
-- The pre-#B.87 "summary mode" only stripped body / edited_body and
-- relied on `title` as the single-line description. Titles are often
-- terse ("smoke-test: ...", "feat: ..."), not a real one-sentence
-- summary. This column lets agents write an explicit 1-2 sentence
-- summary that callers display in lists, search snippets, and ping
-- notifications.
--
-- Nullable on purpose: existing tickets have no summary; the API
-- exposes a `summary ?? title` fallback. New tickets can fill it via
-- `ticket_new({summary})` or `ticket_update({summary})`.

ALTER TABLE tickets ADD COLUMN summary TEXT;
