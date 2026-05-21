// #324 test stack — DB helpers for the isolated, per-file test database.
// `bootstrap.ts` (loaded via `--import`) already pointed AIBALL_HOME at a fresh
// temp dir; here we migrate it (lazily, via getDb) and seed it sanely.
import { getDb } from "../db.js";
import * as schema from "../schema.js";

/**
 * Migrate the per-file isolated test DB and **diverge the message-id counter**
 * far above the ticket-id space. A fresh DB starts both `next_ticket_id` and
 * `next_message_id` at 1; since `getMessage` is tickets-first, overlapping ids
 * misresolve a comment as its ticket (a `comment_added` reads back as
 * `ticket_created`). Pushing message ids to 1_000_000+ keeps the two id spaces
 * disjoint for any realistic test, so flow assertions are trustworthy. #324.
 *
 * Idempotent: safe to call once per test file (or per `beforeEach`).
 */
export function seedTestDb(): void {
    const db = getDb(); // triggers migrate() against the AIBALL_HOME bootstrap set
    db.insert(schema.settings)
        .values({ key: "next_message_id", value: "1000000" })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } })
        .run();
}
