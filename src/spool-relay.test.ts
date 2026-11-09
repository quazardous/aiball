/**
 * #4864 — a proxy node's spool goes to its parent: a real hub in this process,
 * the node's poster aimed at it. A spooled write reaches the hub once, as its
 * author; a write the hub refuses goes to `failed/`; while the hub is out of
 * reach the files stay, in order, for the next drain.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-4864-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");

const { createApp } = await import("./app.js");
const { attachBus } = await import("./bus/server.js");
const { upsertConsumer, getDb } = await import("./db.js");
const { createProject } = await import("./db/projects.js");
const { issueToken } = await import("./db/tokens.js");
const { drainSpool, setSpoolPoster } = await import("./spool.js");
const { relaySpoolPoster } = await import("./spool-relay.js");
const { SPOOL_DIR, SPOOL_FAILED_DIR } = await import("./paths.js");
const schema = await import("./schema.js");

upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p4864" });
const NODE = issueToken({ kind: "node", label: "node-b" }).token;

const hub = createServer(createApp());
attachBus(hub);
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;

after(() => {
    setSpoolPoster(null);
    hub.closeAllConnections();
    hub.close();
    rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function spool(msg: Record<string, unknown>): string {
    mkdirSync(SPOOL_DIR, { recursive: true });
    const name = `${String(Date.now() + seq++).padStart(13, "0")}-${seq}.json`;
    writeFileSync(join(SPOOL_DIR, name), JSON.stringify({ by_agent: "worker", ...msg }));
    return name;
}
const spooled = () => (existsSync(SPOOL_DIR) ? readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json")) : []);
const failed = () => (existsSync(SPOOL_FAILED_DIR) ? readdirSync(SPOOL_FAILED_DIR) : []);
const titled = (title: string) => getDb().select().from(schema.tickets).all().filter((t) => t.title === title);

test("the parent out of reach: the files stay, in order, none goes to failed", async () => {
    setSpoolPoster(relaySpoolPoster({ url: "http://127.0.0.1:1", token: NODE }, new Map()));
    spool({ project: "p4864", kind: "ticket_created", title: "while cut 1", body: "b", idempotency_key: "key-cut-0001" });
    spool({ project: "p4864", kind: "ticket_created", title: "while cut 2", body: "b", idempotency_key: "key-cut-0002" });
    assert.equal(await drainSpool(), 0);
    assert.equal(spooled().length, 2);
    assert.deepEqual(failed(), []);
});

test("the parent back: each spooled write reaches it once, as its author, and leaves the spool", async () => {
    setSpoolPoster(relaySpoolPoster({ url: hubUrl, token: NODE, nodeLabel: "node-b" }, new Map()));
    assert.equal(await drainSpool(), 2);
    assert.deepEqual(spooled(), []);
    const made = titled("while cut 1");
    assert.equal(made.length, 1);
    assert.equal(made[0].byAgent, "worker");
    assert.equal(titled("while cut 2").length, 1);

    // A write that had in fact gone through: its key answers, nothing doubles.
    spool({ project: "p4864", kind: "ticket_created", title: "while cut 1", body: "b", idempotency_key: "key-cut-0001" });
    assert.equal(await drainSpool(), 1);
    assert.equal(titled("while cut 1").length, 1);
});

test("a write the parent refuses goes to failed, like a live call", async () => {
    setSpoolPoster(relaySpoolPoster({ url: hubUrl, token: NODE }, new Map()));
    const name = spool({ project: "p4864", kind: "comment_added", ticket_id: 999_999, body: "r", summary_until: "s", handback: true, commits: null, idempotency_key: "key-refused-1" });
    await drainSpool();
    assert.deepEqual(spooled(), []);
    assert.ok(failed().includes(name));
});

test("strict mode: the node lends no token, so the write stays for its author's client", async () => {
    setSpoolPoster(relaySpoolPoster({ url: hubUrl, token: NODE, strict: true }, new Map()));
    spool({ project: "p4864", kind: "ticket_created", title: "strict", body: "b", idempotency_key: "key-strict-01" });
    assert.equal(await drainSpool(), 0);
    assert.equal(spooled().length, 1);
    assert.equal(titled("strict").length, 0);
});
