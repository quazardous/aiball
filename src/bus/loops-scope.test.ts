/**
 * #3417 — the all-loops controls take a scope: `machine` (the caller's
 * machine's loops) or `all` (the default: every connected loop). On the hub;
 * a proxy node answers `machine` for its own loops and `all` stays closed to it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3417-"));
process.env.AIBALL_SOCK = "";
// No loop of this machine may hear these messages: an empty state root of its own.
process.env.CLAUDE_LOOP_STATE_ROOT = mkdtempSync(join(tmpdir(), "aiball-3417-loops-"));
after(() => { for (const d of [process.env.AIBALL_HOME!, process.env.CLAUDE_LOOP_STATE_ROOT!]) rmSync(d, { recursive: true, force: true }); });

const { getMethod, accessRefusal } = await import("./methods.js");
await import("./register.js");
const { upsertConsumer } = await import("../db.js");
const { testCaller } = await import("../tests/lib.js");
const { presenceConnect, __resetPresence } = await import("../live-presence.js");
const { setThisMachineForTests } = await import("../machine-name.js");
const { onControl } = await import("../event-bus.js");

type Line = { consumer_id: string; prompt?: string; hold?: string; hold_error?: string };
type Answer = { action: string; scope: string; results: Line[] };

setThisMachineForTests("hub");
upsertConsumer({ consumer_id: "boss", kind: "human" });
for (const id of ["hub-a", "desk-a"]) upsertConsumer({ consumer_id: id, kind: "agent" });
__resetPresence();
presenceConnect("hub-a", "terminal", "local");
presenceConnect("desk-a", "terminal", "node:desk");

const human = testCaller("boss", { kind: "human" });
const message = getMethod("loops.message_all")!;
const release = getMethod("loops.release_all")!;
const prompts: string[] = [];
const offs = ["hub-a", "desk-a"].map((id) => onControl(id, (c) => { if ((c as { action?: string }).action === "prompt") prompts.push(id); }));
after(() => { for (const off of offs) off(); });

test("scope machine, on the hub: the hub's loops get the message, a node's do not", async () => {
    prompts.length = 0;
    const r = await message.run(human, { message: "back at five", scope: "machine" } as never) as Answer;
    assert.equal(r.scope, "machine");
    assert.deepEqual(r.results.map((l) => l.consumer_id), ["hub-a"]);
    assert.deepEqual(prompts, ["hub-a"]);
});

test("scope all (the default): every connected loop gets the message; a hold on another machine's loop fails, and says why", async () => {
    prompts.length = 0;
    const r = await message.run(human, { message: "back at five", hold: true } as never) as Answer;
    assert.equal(r.scope, "all");
    assert.deepEqual(r.results.map((l) => l.consumer_id), ["desk-a", "hub-a"]);
    assert.deepEqual(prompts.sort(), ["desk-a", "hub-a"], "the message reaches a loop on any machine");
    const desk = r.results.find((l) => l.consumer_id === "desk-a")!;
    assert.equal(desk.hold, "failed");
    assert.match(desk.hold_error ?? "", /runs on node:desk/);
});

test("release: the same scopes", async () => {
    const mine = await release.run(human, { scope: "machine" } as never) as Answer;
    assert.deepEqual([mine.scope, mine.results.map((l) => l.consumer_id)], ["machine", ["hub-a"]]);
    const all = await release.run(human, {} as never) as Answer;
    assert.deepEqual(all.results.map((l) => l.consumer_id), ["desk-a", "hub-a"]);
    assert.match(all.results.find((l) => l.consumer_id === "desk-a")!.hold_error ?? "", /runs on node:desk/);
});

test("through a proxy node: `machine` is the node's to answer, `all` is relayed and refused upstream", () => {
    for (const m of [message, release]) {
        assert.equal(m.nodeLocal!({ scope: "machine" }), true, "the node runs it for its own loops");
        assert.equal(m.nodeLocal!({}), false, "no scope is `all`: relayed");
        assert.equal(m.nodeLocal!({ scope: "all" }), false);
        assert.equal(accessRefusal(m, testCaller("boss", { kind: "human", relayed: true }))?.code, "FORBIDDEN", "the hub refuses it to a relayed caller");
    }
});

test("on a node with no loop running: scope machine answers an empty list, and asks the hub nothing", async () => {
    setThisMachineForTests("node:desk");
    try {
        prompts.length = 0;
        const node = { ...human, node: true } as never;
        const r = await message.run(node, { message: "anyone?", scope: "machine" } as never) as Answer;
        assert.deepEqual([r.scope, r.results], ["machine", []]);
        assert.deepEqual(prompts, [], "nothing sent on the board's control stream");
        assert.deepEqual((await release.run(node, { scope: "machine" } as never) as Answer).results, []);
    } finally {
        setThisMachineForTests("hub");
    }
});

test("a scope that is neither is refused by the params", () => {
    assert.equal(message.params.safeParse({ message: "x", scope: "galaxy" }).success, false);
});
