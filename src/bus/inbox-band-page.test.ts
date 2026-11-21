/**
 * #5404 — a `sort=band` page builds the rows of the open tickets and only the
 * closed ones it needs, and reads the pilot's facts in bounded chunks. The page
 * must be exactly the slice of the whole list, whatever its offset, and a
 * ticket the viewer acted on last must still read "them" past 200 open rows.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-5404-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

await import("./register.js");
const { getMethod } = await import("./methods.js");
const { testCaller } = await import("../tests/lib.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { submitMessage } = await import("../messages.js");

const P = "p-5404";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("boss", P, "owner");

const file = (title: string, by = "boss") => submitMessage({ project: P, kind: "ticket_created", title, body: "b", by_agent: by }).id;
const say = (id: number, by: string) => submitMessage({ project: P, kind: "comment_added", ticket_id: id, parent_id: id, body: "c", by_agent: by, ...(by === "boss" ? {} : { summary_until: "s", handback: true }) });

// Past 200 open tickets, so the facts are read in more than one chunk.
const open: number[] = [];
for (let i = 0; i < 215; i++) open.push(file(`open ${i}`, i % 3 === 0 ? "worker" : "boss"));
// The worker answered, then the viewer spoke last: "them" for the viewer.
const actedLast = [open[3], open[150], open[212]];
for (const id of actedLast) { say(id, "worker"); say(id, "boss"); }
for (let i = 0; i < 40; i++) {
    const id = file(`closed ${i}`);
    if (i % 2 === 0) say(id, "worker");
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: id, parent_id: id, by_agent: "boss" });
}

type Row = { id: number; band: number; turn: string; closed: boolean };
const list = async (p: Record<string, unknown>) =>
    (await getMethod("inbox.list")!.run(testCaller("boss", { kind: "human" }), { project: P, view: "turn", sort: "band", ...p })) as { total: number; rows: Row[] };

test("a band page is the slice of the whole list, across the open/closed boundary", async () => {
    const whole = await list({});
    assert.equal(whole.rows.length, 255);
    assert.equal(whole.rows.filter((r) => r.closed).length, 40);
    for (const [offset, limit] of [[0, 50], [200, 30], [210, 10], [214, 3], [230, 50], [0, 500]]) {
        const page = await list({ offset, limit });
        assert.equal(page.total, whole.total, `total at ${offset}+${limit}`);
        assert.deepEqual(page.rows, whole.rows.slice(offset, offset + limit), `page ${offset}+${limit}`);
    }
});

test("past 200 open rows, a ticket the viewer acted on last still waits on them", async () => {
    const page = await list({ limit: 300 });
    for (const id of actedLast) assert.equal(page.rows.find((r) => r.id === id)?.turn, "them", `#${id}`);
    // Filed by the agent, untouched since: the viewer's turn.
    assert.equal(page.rows.find((r) => r.id === open[6])?.turn, "you");
});
