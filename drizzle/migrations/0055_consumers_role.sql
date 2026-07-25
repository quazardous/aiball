-- #1435 slice 5 — persist the multi-agent role (lead / crew) on the consumer
-- so it's visible in the UI. Set server-side from the `x-aiball-role` request
-- header (mirrors how no_claim → can_claim is persisted), not via the
-- human-gated PATCH. Nullable: solo/legacy consumers stay NULL.
ALTER TABLE consumers ADD COLUMN role TEXT;
