/**
 * #5000 — the detailed project list is kept per project: after a write, only
 * the projects of the tickets it names are rebuilt. Whatever the write, the
 * list it answers must be the one a whole rebuild gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-5000-plist-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject, listProjectsDetailed, invalidateProjectsDetailed } = await import("./projects.js");
const { getMethod, callMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
for (const p of ["pa", "pb", "pc"]) createProject({ name: p });
const subs = await import("./subscriptions.js");
subs.upsertSubscription("worker", "pa", "owner");
subs.upsertSubscription("worker", "pb", "owner");
const boss = testCaller("boss", { kind: "human" });
const worker = testCaller("worker");
const post = (caller: ReturnType<typeof testCaller>, p: Record<string, unknown>) => getMethod("message.post")!.run(caller, p) as Promise<{ id: number }>;
const ticket = async (project: string, title: string, by = boss) => (await post(by, { kind: "ticket_created", project, title, body: "b" })).id;

// The 5 s ceiling never runs out here: every rebuild the test sees is a write's.
const NOW = Date.now();
const read = (c: string | undefined, landscape: boolean) => listProjectsDetailed(c, landscape, NOW);
const views: Array<[string | undefined, boolean]> = [[undefined, false], ["boss", false], ["worker", true]];

/** What a whole rebuild answers, then the cache back as it was before the call. */
function whole(): unknown[] {
    invalidateProjectsDetailed();
    return views.map(([c, l]) => read(c, l));
}

test("after every kind of write, the per-project cache answers what a whole rebuild does", async () => {
    const a = await ticket("pa", "a");
    const b = await ticket("pb", "b");
    await ticket("pc", "c");
    whole(); // built once; from here each write patches it
    const gestures: Array<[string, () => Promise<unknown>]> = [
        ["file a ticket", () => ticket("pa", "a2")],
        ["file one an agent files (pending)", () => ticket("pc", "by worker", worker)],
        ["comment", () => post(worker, { kind: "comment_added", ticket_id: a, body: "c", summary_until: "s", commits: null, handback: true })],
        ["propose a resolution", () => post(worker, { kind: "comment_added", ticket_id: b, body: "done", summary_until: "s", commits: null, decision_kind: "resolution" })],
        ["close", () => post(boss, { kind: "ticket_closed", ticket_id: a })],
        ["reopen", () => post(boss, { kind: "ticket_reopened", ticket_id: a })],
        ["snooze", () => callMethod(boss, "ticket.postpone", { id: b, until: new Date(NOW + 3_600_000).toISOString() })],
        ["unsnooze", () => callMethod(boss, "ticket.unsnooze", { id: b })],
        ["register a project and file in it", async () => { createProject({ name: "pnew" }); return ticket("pnew", "fresh"); }],
        ["move a ticket to another project", () => callMethod(boss, "ticket.move", { id: a, project: "pc" })],
        ["close the moved ticket", () => post(boss, { kind: "ticket_closed", ticket_id: a })],
    ];
    const differ: string[] = [];
    for (const [what, gesture] of gestures) {
        await gesture();
        const cached = views.map(([c, l]) => read(c, l));
        try { assert.deepEqual(cached, whole()); } catch { differ.push(what); }
    }
    assert.deepEqual(differ, [], "writes after which the cache answered differently from a whole rebuild");
});

test("a write rebuilds only its ticket's project: another project's entry is not recomputed", async () => {
    const t = await ticket("pa", "scoped");
    whole();
    const before = read(undefined, false).find((p) => p.name === "pb")!;
    await post(boss, { kind: "comment_added", ticket_id: t, body: "x" });
    const after = read(undefined, false);
    // The same object fields, and pa moved: pb's entry was carried over, not rebuilt.
    assert.deepEqual(after.find((p) => p.name === "pb"), before);
    assert.ok(after.find((p) => p.name === "pa")!.comment_count! >= 1);
});

test("token usage names no ticket change: it reaches the list at the 5 s ceiling, as before", async () => {
    const t = await ticket("pb", "tokens");
    whole();
    await callMethod(boss, "ticket.add_token_usage", { id: t, in: 3, out: 4 });
    const later = listProjectsDetailed(undefined, false, NOW + 5_001);
    assert.deepEqual(later, (invalidateProjectsDetailed(), listProjectsDetailed(undefined, false, NOW + 5_001)));
});

test("one project asked for answers its row as the whole list has it", async () => {
    await ticket("pa", "one");
    for (const [c, l] of views) {
        const all = read(c, l).filter((p) => p.name === "pa");
        assert.deepEqual(listProjectsDetailed(c, l, NOW, "pa"), all);
    }
    assert.deepEqual(listProjectsDetailed("boss", false, NOW, "no-such"), []);
});
