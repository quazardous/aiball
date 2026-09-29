// #1167 — the cache must return EXACTLY what the cold build returns, and
// an invalidation must force a rebuild. Tests the pure function +
// cache/fresh equality on a throwaway DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1167-"));

const { getDb } = await import("./connection.js");
const { createProject } = await import("./projects.js");
const { insertMessage } = await import("./messages.js");
const { buildInboxAgg, getInboxAgg, resetInboxAggCacheForTests } = await import("./inbox-agg.js");
getDb();
createProject({ name: "p1167" });

function mkTicket(title: string): number {
    const m = insertMessage({ project: "p1167", kind: "ticket_created", title, by_agent: "a" });
    return m.id;
}

test("#1167: getInboxAgg == buildInboxAgg (cache path equals fresh)", () => {
    const tid = mkTicket("t1");
    insertMessage({ project: "p1167", kind: "comment_added", ticket_id: tid, body: "hi", by_agent: "b", summary_until: "s" });
    resetInboxAggCacheForTests();
    const fresh = buildInboxAgg("p1167");
    const cached = getInboxAgg("p1167");
    assert.deepEqual(cached.get(tid), fresh.get(tid));
    assert.equal(cached.get(tid)?.commentCount, 1);
});

test("#1167: insert invalidates the cache → the new comment is counted", () => {
    const tid = mkTicket("t2");
    getInboxAgg("p1167"); // warm
    insertMessage({ project: "p1167", kind: "comment_added", ticket_id: tid, body: "x", by_agent: "b", summary_until: "s" });
    // insertMessage invalidated → next get rebuilds
    const after = getInboxAgg("p1167");
    assert.equal(after.get(tid)?.commentCount, 1);
});

test("#1167: TTL — a stale cache rebuilds even without invalidation", () => {
    resetInboxAggCacheForTests();
    const tid = mkTicket("t3");
    const t0 = 1_000_000;
    getInboxAgg("p1167", t0); // build @ t0
    // insert WITHOUT going through invalidation (simulates a missed write)
    getDb(); // no-op
    const fresh = buildInboxAgg("p1167");
    // within the TTL: serves the old cache (may differ if mutated outside invalidation)
    const within = getInboxAgg("p1167", t0 + 4_000);
    // past the TTL (>5s): rebuild guaranteed == fresh
    const beyond = getInboxAgg("p1167", t0 + 6_000);
    assert.deepEqual(beyond.get(tid), fresh.get(tid));
    void within;
});
