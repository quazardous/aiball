-- #B.104 — sidecar JSON metadata on tickets + messages (comments).
-- Used today for question-answer audit (who toggled which `- [ ]` and
-- when). Nullable so existing rows stay valid; values are JSON strings
-- shaped like `{"questions": {"q-abc": {"answered_by", "answered_at",
-- "answered_in"}}}`. Both tables get the column because questions can
-- live in a ticket's body as much as in a comment's body. Future fields
-- (signatures, polls, ...) live here too — sidecar metadata pattern, no
-- new table needed.
ALTER TABLE tickets   ADD COLUMN meta TEXT;
--> statement-breakpoint
ALTER TABLE _messages ADD COLUMN meta TEXT;
