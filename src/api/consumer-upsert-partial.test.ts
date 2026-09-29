/**
 * #2221 — `consumer.upsert` on an existing record changes only the fields
 * it is sent. It used to default every absent one (null name, null note,
 * enabled true), so `aiball sandbox` wiped an agent's note and re-enabled a
 * disabled agent on each launch. Called over the bus.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2221-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2221-h" }).token;

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function post(body: Record<string, unknown>): Promise<number> {
    return (await asToken(HUMAN, "consumer.upsert", body)).status;
}

test("a partial POST keeps the name, the note and a disabled state", async () => {
    upsertConsumer({ consumer_id: "kept", kind: "agent", display_name: "Nice name", note: "keep me", enabled: false });

    assert.equal(await post({ consumer_id: "kept", kind: "agent" }), 200);

    const c = getConsumer("kept")!;
    assert.equal(c.display_name, "Nice name");
    assert.equal(c.note, "keep me");
    assert.equal(c.enabled, false, "a disabled agent must not be re-enabled by a POST that did not mention it");
});

test("fields that are sent are applied, and an explicit null still clears", async () => {
    upsertConsumer({ consumer_id: "edited", kind: "agent", display_name: "Old", note: "old note", enabled: true });

    assert.equal(await post({ consumer_id: "edited", display_name: "New", note: null, enabled: false }), 200);

    const c = getConsumer("edited")!;
    assert.equal(c.display_name, "New");
    assert.equal(c.note, null);
    assert.equal(c.enabled, false);
});

test("creating a record still gets the defaults", async () => {
    assert.equal(await post({ consumer_id: "fresh", kind: "agent" }), 200);

    const c = getConsumer("fresh")!;
    assert.equal(c.kind, "agent");
    assert.equal(c.display_name, null);
    assert.equal(c.note, null);
    assert.equal(c.enabled, true);
});
