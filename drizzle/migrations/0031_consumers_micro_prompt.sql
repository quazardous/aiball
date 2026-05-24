-- #397: per-consumer micro-prompt — a short standing instruction the operator
-- edits in the UI, injected into the wake/relance prompt via the
-- `{consumer_prompt}` placeholder. NULL = none (opt-in).
ALTER TABLE consumers ADD COLUMN micro_prompt TEXT;
