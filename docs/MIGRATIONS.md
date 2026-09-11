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
- For columns with a CHECK constraint: SQLite can't `ALTER TABLE … ALTER COLUMN`. Change the column in place (see "Changing a CHECK constraint") — rebuild the table only if nothing references it (see "Temp-table swap").

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

## Changing a CHECK constraint

Don't rebuild the table: rename the column, add the new one with the new CHECK, copy the values across, drop the old column. No table is ever dropped, so no foreign-key action can fire, and it runs inside the migrator's transaction:

```sql
ALTER TABLE foo RENAME COLUMN kind TO kind_old;--> statement-breakpoint
ALTER TABLE foo ADD COLUMN kind TEXT NOT NULL DEFAULT 'a' CHECK (kind IN ('a', 'b', 'c'));--> statement-breakpoint
UPDATE foo SET kind = CASE kind_old WHEN 'x' THEN 'b' ELSE 'a' END;--> statement-breakpoint
ALTER TABLE foo DROP COLUMN kind_old;
```

The column moves to the end of the table, which nothing in aiball depends on. `DROP COLUMN` refuses a column used by an index, a trigger, a view or a foreign key — check `sqlite_master` first.

## Temp-table swap (for changes SQLite can't do in-place)

> **Never on a table other tables reference.** The migrator runs every pending migration inside one transaction with `foreign_keys = ON`, and `PRAGMA foreign_keys = OFF` is a no-op inside a transaction. `DROP TABLE foo` then performs an implicit `DELETE FROM foo`, and every `ON DELETE CASCADE` child row goes with it — `defer_foreign_keys` defers the *checks*, not the *actions*. Renaming the old table under `legacy_alter_table` does not help either: with foreign keys on, SQLite rewrites the children's `REFERENCES` to follow the rename. Measured on a copy of the live database, a swap of `tickets` emptied `_messages` and every other child table while `integrity_check` and `foreign_key_check` both reported nothing wrong. Before a swap, list the references: `SELECT m.name, f.* FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE f."table" = 'foo'`.

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

`migrate()` fires once per process, on the first `getDb()` call. In the dev setup that is **more often than it sounds**: the daemon runs under `tsx watch`, and saving any imported `.ts` restarts the whole process — not just the changed module. So a save applies any pending migration to the **live** DB, with no explicit command. Verified on migration 0056: saving `src/schema.ts` applied it; no `aiball restart` was involved.

Treat that as a discipline rather than a convenience: **a migration file plus its `_journal.json` entry sitting on disk is already armed**, and the next save ships it. Don't leave one half-finished while you keep editing — test it on a copy first (above), and add the journal entry only when you mean it to run.

`aiball restart` remains the way to apply a migration without touching source, and the only way when the daemon is not running under `tsx watch`.

## Conventions checklist

When committing a migration, double-check:

- [ ] File named `NNNN_label.sql` with `;--> statement-breakpoint` between statements.
- [ ] Entry added in `drizzle/migrations/meta/_journal.json` with the same tag.
- [ ] `src/schema.ts` updated to match.
- [ ] Any new fields exposed in `src/db/connection.ts:Message` (and the row converters) if they need to surface in API responses.
- [ ] Migration has been smoke-tested on a DB copy, not on live data first.
- [ ] Daemon restart verified locally before pushing.
