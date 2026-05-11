# Migrations — drizzle + SQLite

aiball uses [drizzle-kit](https://orm.drizzle.team/) over `better-sqlite3`. Migrations live in `drizzle/migrations/NNNN_label.sql` and run at daemon boot from `getDb()` in `src/db/connection.ts`.

This page covers the conventions you need to write a migration that won't blow up at boot — gathered the hard way while shipping migrations 0005, 0006, 0007 and 0009.

## File format

- One file per migration: `NNNN_short_label.sql`, where `NNNN` is the next zero-padded index (look at the latest entry in `drizzle/migrations/meta/_journal.json`).
- Multiple SQL statements **must** be separated by the explicit token `;--> statement-breakpoint` on its own. Drizzle's migrator splits on this token; without it, only the first statement runs and the rest is silently dropped.

```sql
ALTER TABLE foo ADD COLUMN bar INTEGER;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_foo_bar ON foo(bar);
```

- The migrator wraps each migration file in a transaction. PRAGMAs that need to be set outside a transaction (e.g. `foreign_keys`) don't work here — use `defer_foreign_keys` instead (see below).
- After adding the file, append an entry to `drizzle/migrations/meta/_journal.json` with the same index and tag. Without that the migrator skips the file.

## Updating `src/schema.ts`

`drizzle-kit` lets you reverse-engineer schemas, but for this repo we hand-author SQL migrations and keep `src/schema.ts` in sync manually. After writing a migration:

1. Add the new column / index / constraint to the matching `sqliteTable(...)` in `src/schema.ts`.
2. Re-export anything new from `src/db/<module>.ts` and the barrel `src/db.ts` if it needs to be visible to other modules.
3. `npx tsc --noEmit` to catch type drift.

## Adding a value to an enum-like text column

SQLite doesn't have a real ENUM type; aiball's enum-shaped columns (`kind`, `status`, `intent`, …) are plain `TEXT`. To add a new value:

- For columns used only as discriminators (e.g. `_messages.kind`): no schema change, just update the TypeScript union (`src/db/connection.ts:MessageKind`) and any `VALID_KINDS` array. The migration file might be empty or just a comment.
- For columns with a CHECK constraint (none in aiball today, but possible): you'd need to rebuild the table because SQLite can't `ALTER TABLE … ALTER COLUMN`. See the "Temp-table swap" section.

## Renumbering / re-keying with FK columns

When a migration needs to **change values of primary keys that other tables reference** (e.g. migration 0007 renumbered `tickets.id`), the normal foreign-key checks fire row-by-row and you can't update everything atomically without help. Options:

### `PRAGMA defer_foreign_keys = ON`

Set this as the first statement in the migration:

```sql
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
-- … your updates here. FKs are checked at COMMIT, not per-row.
```

The migrator's transaction commits at the end of the migration; FK violations surface there. Inside the migration you can update tables in any order without per-row checks blowing up.

### Two-step shift via large offset

When two columns of the same primary-key sequence need to swap or be renumbered to dense values (and `UNIQUE`/`PRIMARY KEY` constraints would clash mid-update), the standard trick is:

1. Shift everything by a large offset (e.g. `+1_000_000`) so the original range is free.
2. Build a temp mapping table that pairs offset ids with final ids.
3. Update FK columns and the PK column from the mapping.

`drizzle/migrations/0007_split_pings_renumber_tickets.sql` is the canonical example in this repo.

## Temp-table swap (for changes SQLite can't do in-place)

SQLite cannot drop or alter most column types/constraints. The general recipe is:

```sql
CREATE TABLE foo_new (
    -- new schema goes here
);--> statement-breakpoint

INSERT INTO foo_new (col1, col2, ...)
SELECT col1, col2, ... FROM foo;--> statement-breakpoint

DROP TABLE foo;--> statement-breakpoint
ALTER TABLE foo_new RENAME TO foo;--> statement-breakpoint

-- Recreate indexes and triggers that don't transfer with RENAME.
CREATE INDEX idx_foo_col ON foo(col);
```

Be careful with FTS5 virtual tables — they have their own indices and triggers that need to be recreated explicitly after the swap (cf. the search FTS5 setup in 0004 if you need to extend it).

## Polymorphic id namespaces

Until 0007, aiball used one shared `nextGlobalId` counter for `tickets.id` and `_messages.id` because `pings.message_id` was a polymorphic FK pointing at either. 0007 split that:

- `pings.ticket_id` and `pings.comment_id` (mutually exclusive, CHECK-enforced) instead of one polymorphic column.
- `tickets.id` and `_messages.id` keep separate counters (`next_ticket_id`, `next_message_id`). To guarantee they never overlap, `_messages.id` was shifted by `+1_000_000` so the comment id range starts well above any plausible ticket id.

If you add a new table with FK references to either, follow the same split pattern — don't reintroduce a polymorphic id column.

## Testing a migration

1. **Backup the live DB first**: `cp ~/.local/share/aiball/aiball.db /tmp/aiball-test.db`. WAL files matter — also copy `*-wal` and `*-shm`.
2. Run the migration against the test file: `sqlite3 /tmp/aiball-test.db < drizzle/migrations/NNNN_…sql`.
3. Verify: row counts, `PRAGMA foreign_key_check`, sample queries.
4. Only then restart the daemon to apply on the live DB.

The daemon's tsx-watch loop **does not** re-run migrations — `migrate()` only fires the first time `getDb()` is called per process. To trigger a migration you need a full process restart (`systemctl --user restart aiball` in the dev setup).

## Conventions checklist

When committing a migration, double-check:

- [ ] File named `NNNN_label.sql` with `;--> statement-breakpoint` between statements.
- [ ] Entry added in `drizzle/migrations/meta/_journal.json` with the same tag.
- [ ] `src/schema.ts` updated to match.
- [ ] Any new fields exposed in `src/db/connection.ts:Message` (and the row converters) if they need to surface in API responses.
- [ ] Migration has been smoke-tested on a DB copy, not on live data first.
- [ ] Daemon restart verified locally before pushing.
