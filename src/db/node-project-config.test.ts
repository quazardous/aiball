// #775 — unit tests for the `node_project_config` store. Drives the
// REAL throwaway SQLite (migration 0050 runs on first getDb).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-775-db-"));

const {
    upsertNodeProjectConfig,
    listConfigsForNode,
    findConsumerConfig,
    getNodeProjectConfig,
    deleteConfigsForNode,
} = await import("./node-project-config.js");

test("upsert + get round-trips the payload verbatim", () => {
    const r = upsertNodeProjectConfig("tok-A", "aiball", {
        consumers: [{ agent: "aiball-win", no_claim: true }],
    });
    assert.equal(r.node_token, "tok-A");
    assert.equal(r.project, "aiball");
    const fetched = getNodeProjectConfig("tok-A", "aiball");
    assert.ok(fetched);
    assert.deepEqual(fetched.config.consumers, [{ agent: "aiball-win", no_claim: true }]);
});

test("re-upsert overwrites the same (token, project) row", () => {
    upsertNodeProjectConfig("tok-A", "aiball", {
        consumers: [{ agent: "aiball-win", no_claim: true }],
    });
    upsertNodeProjectConfig("tok-A", "aiball", {
        consumers: [{ agent: "aiball-win", no_claim: false }],
    });
    const fetched = getNodeProjectConfig("tok-A", "aiball");
    assert.equal(fetched?.config.consumers[0]?.no_claim, false);
});

test("listConfigsForNode returns every project pushed by a token", () => {
    upsertNodeProjectConfig("tok-multi", "proj-a", { consumers: [{ agent: "a", no_claim: true }] });
    upsertNodeProjectConfig("tok-multi", "proj-b", { consumers: [{ agent: "b", no_claim: false }] });
    const rows = listConfigsForNode("tok-multi");
    assert.equal(rows.length, 2);
    const projects = rows.map((r) => r.project).sort();
    assert.deepEqual(projects, ["proj-a", "proj-b"]);
});

test("findConsumerConfig scans by (agent, project)", () => {
    upsertNodeProjectConfig("tok-X", "scoped", {
        consumers: [{ agent: "carol", no_claim: true }, { agent: "dave", no_claim: false }],
    });
    const hit = findConsumerConfig("dave", "scoped");
    assert.ok(hit);
    assert.equal(hit.consumer.no_claim, false);
    assert.equal(findConsumerConfig("nobody", "scoped"), null);
    assert.equal(findConsumerConfig("dave", "other-project"), null);
});

test("deleteConfigsForNode purges every row of a revoked token", () => {
    upsertNodeProjectConfig("tok-purge", "p1", { consumers: [] });
    upsertNodeProjectConfig("tok-purge", "p2", { consumers: [] });
    deleteConfigsForNode("tok-purge");
    assert.equal(listConfigsForNode("tok-purge").length, 0);
});
