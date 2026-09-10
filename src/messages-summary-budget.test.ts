// #2203 — an agent's summary_until has a budget, and going over it is REFUSED,
// never truncated. What must hold: the budget is exact (at it passes, one over
// is refused), the refusal says what to write and that nothing was posted, an
// accepted summary is kept whole, humans are exempt, and a moderator can move
// the budget per project or lift it with 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2203-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./db/connection.js");
const { upsertConsumer } = await import("./db.js");
const { validateNewMessage } = await import("./messages.js");
const { setConfigOverride, deleteConfigOverride } = await import("./db/config-overrides.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });

const KEY = "tickets.summary_until_max";
const reply = (by: string, summary: string, project = "p1") =>
    validateNewMessage({ project, kind: "comment_added", ticket_id: 1, body: "x", by_agent: by, summary_until: summary });
const errorOf = (r: unknown) => (r && typeof r === "object" && "error" in r ? String((r as { error: unknown }).error) : null);

test("a summary exactly at the budget is accepted, and kept whole", () => {
    const r = reply("worker", "a".repeat(500));
    assert.equal(errorOf(r), null);
    assert.ok(JSON.stringify(r).includes("a".repeat(500)), "not truncated");
});

test("one character over is refused, and the refusal says what to write", () => {
    const err = errorOf(reply("worker", "a".repeat(501)));
    assert.ok(err, "refused");
    assert.match(err, /501 characters; the budget is 500/);
    assert.match(err, /where it stands, who plays next, what is still open/);
    assert.match(err, /Nothing was posted/);
});

test("humans are exempt from the budget", () => {
    assert.equal(errorOf(reply("boss", "h".repeat(2000))), null);
});

test("a moderator moves the budget per project, and 0 lifts it", () => {
    try {
        setConfigOverride("", KEY, 100);
        assert.match(errorOf(reply("worker", "a".repeat(150), "p1")) ?? "", /the budget is 100/);

        setConfigOverride("p2", KEY, 1000);
        assert.equal(errorOf(reply("worker", "a".repeat(800), "p2")), null, "p2's own budget applies");
        assert.ok(errorOf(reply("worker", "a".repeat(800), "p1")), "p1 still falls back to the global 100");

        setConfigOverride("", KEY, 0);
        assert.equal(errorOf(reply("worker", "a".repeat(3000), "p1")), null, "0 = no limit");
    } finally {
        deleteConfigOverride("", KEY);
        deleteConfigOverride("p2", KEY);
    }
});
