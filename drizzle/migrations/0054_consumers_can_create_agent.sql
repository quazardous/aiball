-- #1435 slice 7 — lead capability. A consumer with can_create_agent = 1 may
-- provision/launch crew agents (the "lead"). Human-granted only (gated like
-- can_claim by the #1477 guard on PATCH /consumers). Default 0: no agent can
-- create crews until a human grants it, so the capability isn't decorative.
ALTER TABLE consumers ADD COLUMN can_create_agent INTEGER NOT NULL DEFAULT 0;
