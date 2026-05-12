-- Rename the `actors` table to `consumers` (#B.79 follow-up). The
-- existing `consumer_id` column on every other table already used the
-- word "consumer" — calling the registry "consumers" matches the UI
-- picker that's been labelled "Consumer ID" since v0.1.0. The
-- helpers in src/db/consumers.ts mirror this rename; the WS event is
-- renamed `consumer_changed` and the REST surface moves to
-- `/api/consumers`.

ALTER TABLE actors RENAME TO consumers;--> statement-breakpoint

-- Indexes follow the table when renamed in SQLite; rename the named
-- one to match the new convention.
DROP INDEX IF EXISTS idx_actors_kind;--> statement-breakpoint
CREATE INDEX idx_consumers_kind ON consumers(kind);
