// #3245 — a write the client spooled after a lost answer is replayed as the bus's message.post: its key answers with the message already made, never a second one; the post's guards apply to the replay.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3245-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { SPOOL_DIR, SPOOL_FAILED_DIR, ensureDirs } = await import("./paths.js");
const { upsertConsumer } = await import("./db.js");
const { getDb } = await import("./db/connection.js");
const { createProject } = await import("./db/projects.js");
const { submitMessage } = await import("./messages.js");
const { callerOf, callMethod } = await import("./bus/methods.js");
await import("./bus/register.js");
const { drainSpool } = await import("./spool.js");
const schema = await import("./schema.js");
const { and, eq } = await import("drizzle-orm");
after(() => rmSync(home, { recursive: true, force: true }));

getDb(); ensureDirs();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-3245" });
const ticket = submitMessage({ project: "p-3245", kind: "ticket_created", title: "t", body: "b", by_agent: "boss" }).id;
const comments = () => getDb().select().from(schema.messages)
    .where(and(eq(schema.messages.ticketId, ticket), eq(schema.messages.kind, "comment_added"))).all().length;
const worker = callerOf({ consumer_id: "worker", token_kind: "agent", transport: "uds", token: null });
const comment = (body: string, key?: string) => ({
    project: "p-3245", kind: "comment_added", ticket_id: ticket, body, by_agent: "worker", summary_until: "s", handback: true,
    ...(key ? { idempotency_key: key } : {}),
});
let n = 0;
const spool = (msg: unknown) => writeFileSync(join(SPOOL_DIR, `${Date.now()}-${n++}.json`), JSON.stringify(msg));

test("a write that went through, then spooled with the same key: one comment, the replay answered with it", async () => {
    const before = comments();
    const first = await callMethod(worker, "message.post", comment("went through", "key-3245-aaaa")) as { id: number };
    spool(comment("went through", "key-3245-aaaa"));
    assert.equal(await drainSpool(), 1);
    assert.equal(comments(), before + 1, "posted once");
    const again = await callMethod(worker, "message.post", comment("went through", "key-3245-aaaa")) as { id: number; replayed?: boolean };
    assert.deepEqual([again.id, again.replayed], [first.id, true], "the key answers with the message it made");
    assert.deepEqual(readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json")), [], "the spool file is consumed");
});

test("a spooled write that never reached the daemon is posted; another author's key answers nothing of the first's", async () => {
    const before = comments();
    spool(comment("never reached", "key-3245-bbbb"));
    await drainSpool();
    assert.equal(comments(), before + 1);
    const other = await callMethod(callerOf({ consumer_id: "boss", token_kind: "agent", transport: "uds", token: null }), "message.post",
        { ...comment("the boss's own", "key-3245-bbbb"), by_agent: "boss" }) as { replayed?: boolean };
    assert.equal(other.replayed, undefined, "a key belongs to its author");
});

test("a replay goes through message.post's guards: an agent comment with neither a then nor a handback is refused into failed/", async () => {
    const before = comments();
    const { handback: _h, ...bare } = comment("no handback", "key-3245-cccc");
    spool(bare);
    await drainSpool();
    assert.equal(comments(), before, "not posted");
    assert.equal(readdirSync(SPOOL_FAILED_DIR).length, 1, "kept in failed/ with the refusal");
});
