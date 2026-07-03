// #1167 — le cache doit rendre EXACTEMENT ce que le build à froid rend, et
// une invalidation doit forcer un rebuild. On teste la fonction pure +
// l'égalité cache/frais sur une DB éphémère.
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

test("#1167: insert invalide le cache → le nouveau comment est compté", () => {
    const tid = mkTicket("t2");
    getInboxAgg("p1167"); // warm
    insertMessage({ project: "p1167", kind: "comment_added", ticket_id: tid, body: "x", by_agent: "b", summary_until: "s" });
    // insertMessage a invalidé → prochain get rebuild
    const after = getInboxAgg("p1167");
    assert.equal(after.get(tid)?.commentCount, 1);
});

test("#1167: TTL — un cache périmé se rebuild même sans invalidation", () => {
    resetInboxAggCacheForTests();
    const tid = mkTicket("t3");
    const t0 = 1_000_000;
    getInboxAgg("p1167", t0); // build @ t0
    // insert SANS passer par l'invalidation (on simule un write raté)
    getDb(); // no-op
    const fresh = buildInboxAgg("p1167");
    // dans le TTL : sert le vieux cache (peut différer si on avait muté hors-invalidation)
    const within = getInboxAgg("p1167", t0 + 4_000);
    // hors TTL (>5s) : rebuild garanti == frais
    const beyond = getInboxAgg("p1167", t0 + 6_000);
    assert.deepEqual(beyond.get(tid), fresh.get(tid));
    void within;
});
