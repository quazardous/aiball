// #466 — regression : the "Top 3 token-heavy" panel was sorted by a key
// (estTokenCost = effort + 0.1×cache_r) that didn't match the UI's display
// value (estTokenEffort = effort only). A ticket with high effort + low
// cache_r surfaced AT THE BOTTOM of the supposed top-3 — david's screenshot
// showed a 400k-effort ticket below two ~53k ones because the smaller
// tickets had massive cache_r tallies that won the cost-equivalent sort.
//
// This pins the invariant : the sort key in getProjectStatsRich matches
// the frontend's estTokenEffort exactly.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-466-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { addTicketTokenUsage } = await import("./token-usage.js");
const { getProjectStatsRich } = await import("./projects.js");

const PROJECT = "sim-466";
const db = getDb();

// 3 tickets in the same project. The "effort" (in + cache_w + out) ranks
// HIGH ticket first, MID second, LOW third. But the deprecated cost-equiv
// sort would rank LOW first (its cache_r alone times 0.1 = 8M, dwarfing
// HIGH's 400k effort) — exactly david's screenshot pathology.
function seed(id: number) {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}`,
        status: "approved",
        createdAt: nowIso(),
    }).run();
}
seed(1); seed(2); seed(3);

// HIGH : 400k effort (in=400k), no cache reads.
addTicketTokenUsage(1, { in: 400_000, out: 0, cacheW: 0, cacheR: 0 });
// MID  : 57k effort, light cache.
addTicketTokenUsage(2, { in: 50_000, out: 5_000, cacheW: 2_000, cacheR: 1_000_000 });
// LOW  : 53k effort, MASSIVE cache_r (80M → 8M at the 0.1× rate, would
//        win a cost-equiv sort easily, but is NOT what the user sees).
addTicketTokenUsage(3, { in: 50_000, out: 0, cacheW: 3_000, cacheR: 80_000_000 });

test("#466 top_token_tickets sorted by effort (matches UI), not by cost-equiv", () => {
    const stats = getProjectStatsRich(PROJECT);
    const top = stats.top_token_tickets;
    assert.equal(top.length, 3, "all 3 surfaced as top");
    // The HIGH-effort ticket must come FIRST — david's screenshot pathology.
    assert.equal(top[0]!.id, 1, "ticket 1 (400k effort) at the top");
    assert.equal(top[1]!.id, 2, "ticket 2 (57k effort) second");
    assert.equal(top[2]!.id, 3, "ticket 3 (53k effort + huge cache_r) last");
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});
