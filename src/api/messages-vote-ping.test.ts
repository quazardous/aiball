// #749 david `wfhw74` — a thumb-up (+1) on a comment pings the comment
// author so the wake-FIFO surfaces "your comment got attention". Spawns
// the real app on an ephemeral port, POSTs a vote, asserts the row in
// `pings`. -1 (thumb down) and 0 (retract) stay silent. Self-vote is a
// no-op for the ping (self-ping filter).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-749-"));
process.env.AIBALL_HOME = home;

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { ensureConsumer } = await import("../db.js");
const { getDb, nowIso } = await import("../db/connection.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const AUTHOR = "vote-author";
const VOTER = "vote-voter";
ensureConsumer(AUTHOR);
ensureConsumer(VOTER);
const TOKEN_VOTER = issueToken({ kind: "agent", consumer_id: VOTER, label: "749-voter" }).token;
const TOKEN_AUTHOR = issueToken({ kind: "agent", consumer_id: AUTHOR, label: "749-author" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

after(() => {
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const db = getDb();
db.insert(schema.tickets).values({
    id: 1,
    project: "p-749",
    displaySeq: 1,
    title: "T1",
    status: "approved",
    createdAt: nowIso(),
    byAgent: AUTHOR,
}).run();

function seedComment(by: string): number {
    const now = nowIso();
    const r = db.insert(schema.messages).values({
        kind: "comment_added",
        ticketId: 1,
        body: "hello",
        byAgent: by,
        status: "approved",
        createdAt: now,
        decidedAt: now,
        decidedBy: "auto",
        displaySeq: Math.floor(Math.random() * 1_000_000_000),
    }).returning().get();
    return r.id;
}

function pingsOnComment(commentId: number, recipient: string): number {
    return db.select({ c: schema.pings.recipient })
        .from(schema.pings)
        .where(eq(schema.pings.commentId, commentId))
        .all()
        .filter((r) => r.c === recipient)
        .length;
}

async function vote(commentId: number, value: 1 | -1 | 0, token: string): Promise<number> {
    const r = await fetch(`${BASE}/api/messages/${commentId}/vote`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value }),
    });
    return r.status;
}

test("#749: +1 on someone else's comment pings the author", async () => {
    const id = seedComment(AUTHOR);
    assert.equal(await vote(id, 1, TOKEN_VOTER), 200);
    assert.equal(pingsOnComment(id, AUTHOR), 1);
});

test("#749: -1 (thumb down) does NOT ping the author", async () => {
    const id = seedComment(AUTHOR);
    assert.equal(await vote(id, -1, TOKEN_VOTER), 200);
    assert.equal(pingsOnComment(id, AUTHOR), 0);
});

test("#749: 0 (retract) does NOT ping the author", async () => {
    const id = seedComment(AUTHOR);
    assert.equal(await vote(id, 0, TOKEN_VOTER), 200);
    assert.equal(pingsOnComment(id, AUTHOR), 0);
});

test("#749: self-vote (+1 on own comment) does NOT ping the author", async () => {
    const id = seedComment(AUTHOR);
    assert.equal(await vote(id, 1, TOKEN_AUTHOR), 200);
    assert.equal(pingsOnComment(id, AUTHOR), 0);
});

test("#749: multiple voters dedupe via the unique (recipient, comment) index — one ping max", async () => {
    const id = seedComment(AUTHOR);
    // Mint a 2nd voter
    ensureConsumer("vote-voter-2");
    const T2 = issueToken({ kind: "agent", consumer_id: "vote-voter-2", label: "749-voter-2" }).token;
    assert.equal(await vote(id, 1, TOKEN_VOTER), 200);
    assert.equal(await vote(id, 1, T2), 200);
    assert.equal(pingsOnComment(id, AUTHOR), 1, "the dedup keeps the author from being spammed");
});
