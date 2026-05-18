-- #B.177: last_seen + claude-loop state surface on the consumers row.
-- A. last_seen_at — touched on every API call that resolves a consumer.
-- B1. state / state_since / state_updated_at — pushed by claude-loop
--     timer on each heartbeat (busy/idle/boot). UI uses
--     state_updated_at > 60s ago to render "offline".

ALTER TABLE consumers ADD COLUMN last_seen_at TEXT;--> statement-breakpoint
ALTER TABLE consumers ADD COLUMN state TEXT;--> statement-breakpoint
ALTER TABLE consumers ADD COLUMN state_since TEXT;--> statement-breakpoint
ALTER TABLE consumers ADD COLUMN state_updated_at TEXT;
