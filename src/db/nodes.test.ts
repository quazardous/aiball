// #424 — Nodes view: pure helpers + an in-process integration on a temp DB
// (migration runs). node:test + tsx. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB before importing anything that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-424-"));

const { nodeId, relayedFor, listNodes, revokeNode } = await import("./nodes.js");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");

test("nodeId: deterministic, 16 hex, never the token value", () => {
    assert.equal(nodeId("aiball-deadbeef"), nodeId("aiball-deadbeef"));
    assert.equal(nodeId("aiball-deadbeef").length, 16);
    assert.doesNotMatch(nodeId("aiball-deadbeef"), /aiball/);
    assert.notEqual(nodeId("aiball-a"), nodeId("aiball-b"));
});

test("relayedFor: groups consumers by the node's ip; none when ip null", () => {
    const cs = [
        { consumer_id: "alice", last_seen_ip: "100.64.0.3", last_seen_at: "t1" },
        { consumer_id: "bob", last_seen_ip: "100.64.0.9", last_seen_at: "t2" },
        { consumer_id: "carol", last_seen_ip: "100.64.0.3", last_seen_at: "t3" },
    ];
    assert.deepEqual(relayedFor("100.64.0.3", cs).map((c) => c.consumer_id).sort(), ["alice", "carol"]);
    assert.equal(relayedFor(null, cs).length, 0);
    assert.equal(relayedFor("10.0.0.1", cs).length, 0);
});

const db = getDb();
db.insert(schema.tokens).values({ token: "aiball-node1", kind: "node", label: "macbook", createdAt: nowIso(), lastSeenIp: "100.64.0.3" }).run();
db.insert(schema.tokens).values({ token: "aiball-agent1", kind: "agent", createdAt: nowIso() }).run();
db.insert(schema.consumers).values({ consumerId: "alice", kind: "agent", enabled: 1, createdAt: nowIso(), updatedAt: nowIso(), lastSeenVia: "node", lastSeenIp: "100.64.0.3", lastSeenAt: nowIso() }).run();
db.insert(schema.consumers).values({ consumerId: "local", kind: "agent", enabled: 1, createdAt: nowIso(), updatedAt: nowIso(), lastSeenVia: "uds" }).run();

test("listNodes: only node tokens, relayed consumers grouped by ip, token hidden", () => {
    const nodes = listNodes();
    assert.equal(nodes.length, 1); // the agent token is excluded
    assert.equal(nodes[0].label, "macbook");
    assert.equal(nodes[0].last_seen_ip, "100.64.0.3");
    assert.deepEqual(nodes[0].relayed.map((r) => r.consumer_id), ["alice"]); // 'local' (uds) excluded
    assert.equal(nodes[0].relayed_count, 1);
    assert.doesNotMatch(JSON.stringify(nodes[0]), /aiball-node1/); // token value never exposed
});

test("revokeNode: by node_id deletes the token; unknown id → false", () => {
    const id = listNodes()[0].node_id;
    assert.equal(revokeNode("deadbeefdeadbeef"), false);
    assert.equal(revokeNode(id), true);
    assert.equal(listNodes().length, 0);
});

after(() => {
    try {
        rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true });
    } catch {
        /* best-effort temp cleanup */
    }
});
