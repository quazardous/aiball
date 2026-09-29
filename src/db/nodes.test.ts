// #424 — Nodes view: pure helpers + an in-process integration on a temp DB
// (migration runs). node:test + tsx. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB before importing anything that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-424-"));

const { nodeId, listNodes, revokeNode } = await import("./nodes.js");
const { noteRelayed } = await import("../relayed-by.js");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

test("nodeId: deterministic, 16 hex, never the token value", () => {
    assert.equal(nodeId("aiball-deadbeef"), nodeId("aiball-deadbeef"));
    assert.equal(nodeId("aiball-deadbeef").length, 16);
    assert.doesNotMatch(nodeId("aiball-deadbeef"), /aiball/);
    assert.notEqual(nodeId("aiball-a"), nodeId("aiball-b"));
});

const db = getDb();
db.insert(schema.tokens).values({ token: "aiball-node1", kind: "node", label: "macbook", createdAt: nowIso(), lastSeenIp: "100.64.0.3" }).run();
db.insert(schema.tokens).values({ token: "aiball-agent1", kind: "agent", createdAt: nowIso() }).run();
db.insert(schema.consumers).values({ consumerId: "alice", kind: "agent", enabled: 1, createdAt: nowIso(), updatedAt: nowIso(), lastSeenVia: "node", lastSeenIp: "100.64.0.3", lastSeenAt: nowIso() }).run();
db.insert(schema.consumers).values({ consumerId: "local", kind: "agent", enabled: 1, createdAt: nowIso(), updatedAt: nowIso(), lastSeenVia: "uds" }).run();

test("listNodes: only node tokens, relayed consumers by the node their calls came through, token hidden", () => {
    // #3349 — attributed by the node's token, not its address: a second node at
    // the same address (both behind tailscale serve), and one with none, relay nobody.
    db.insert(schema.tokens).values({ token: "aiball-node2", kind: "node", label: "same-ip", createdAt: nowIso(), lastSeenIp: "100.64.0.3" }).run();
    db.insert(schema.tokens).values({ token: "aiball-node3", kind: "node", label: "never", createdAt: nowIso() }).run();
    db.insert(schema.consumers).values({ consumerId: "no-ip", kind: "agent", enabled: 1, createdAt: nowIso(), updatedAt: nowIso(), lastSeenVia: "node", lastSeenAt: nowIso() }).run();
    noteRelayed("alice", nodeId("aiball-node1"));
    noteRelayed("no-ip", nodeId("aiball-node1"));
    const all = listNodes();
    assert.equal(all.length, 3);
    assert.deepEqual(all.find((n) => n.label === "same-ip")!.relayed, [], "the same address is not the same node");
    assert.deepEqual(all.find((n) => n.label === "never")!.relayed, [], "no address matches no agent either");
    for (const t of ["aiball-node2", "aiball-node3"]) db.delete(schema.tokens).where(eq(schema.tokens.token, t)).run();
    const nodes = listNodes();
    assert.equal(nodes.length, 1); // the agent token is excluded
    assert.equal(nodes[0].label, "macbook");
    assert.equal(nodes[0].last_seen_ip, "100.64.0.3");
    assert.deepEqual(nodes[0].relayed.map((r) => r.consumer_id).sort(), ["alice", "no-ip"], "even an agent whose address was never recorded");
    assert.equal(nodes[0].relayed_count, 2);
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
