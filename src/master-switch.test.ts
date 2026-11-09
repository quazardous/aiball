/**
 * #4868 — the pieces of a master switch that need no second machine: which
 * links a master's tokens may cross, what waits while the board is handed
 * over, and that the board's own periodic writes stop meanwhile.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4868-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "cfg");
after(() => rmSync(home, { recursive: true, force: true }));

const { secureLink, switchReadiness, takeOver } = await import("./master-switch.js");
const { listSwitches, recordSwitch } = await import("./db/master-switches.js");
const { beginSwitching, endSwitching, waitsForSwitch, boardWritesHere } = await import("./switch-state.js");
const { callMethod } = await import("./bus/methods.js");
await import("./bus/register.js");
const { testCaller } = await import("./tests/lib.js");
const { upsertConsumer } = await import("./db.js");

test("a master's tokens cross https, a tailnet or this machine, nothing else", () => {
    for (const ok of ["https://a.example:7777", "http://127.0.0.1:7791", "http://localhost:7777", "http://100.64.1.2:7777", "http://100.127.0.9:7777", "http://box.tail1234.ts.net:7777"]) assert.equal(secureLink(ok), true, ok);
    for (const no of ["http://192.168.1.10:7777", "http://100.128.0.1:7777", "http://a.example:7777", "not a url"]) assert.equal(secureLink(no), false, no);
});

test("while the board is handed over, writes wait and reads, replica calls and machine methods do not", async () => {
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    assert.equal(boardWritesHere(), true);
    beginSwitching({ to: "node:b", since: new Date().toISOString(), last: 1 });
    try {
        assert.equal(waitsForSwitch("message.post", false), true);
        assert.equal(waitsForSwitch("ticket.get", false), false);
        assert.equal(waitsForSwitch("replica.handover_commit", false), false);
        assert.equal(waitsForSwitch("loop.restart", true), false);
        assert.equal(boardWritesHere(), false, "the board's periodic writes stop too");
        await assert.rejects(callMethod(testCaller("boss", { kind: "human" }), "message.post", { kind: "ticket_created", project: "p", title: "t" }), (e: unknown) =>
            (e as { status?: number; code?: string }).status === 503 && (e as { code?: string }).code === "SWITCHING");
    } finally {
        endSwitching();
    }
    assert.equal(waitsForSwitch("message.post", false), false);
});

test("a switch is a node's gesture: a master refuses it from anyone else", async () => {
    await assert.rejects(callMethod(testCaller("boss", { kind: "human" }), "replica.handover_begin", {}), /node token/);
});

test("#4874 — a daemon that is no proxy node is not ready, and says why", () => {
    const r = switchReadiness(null, null);
    assert.equal(r.ready, false);
    assert.match(r.reasons.join(" "), /not a proxy node/);
});

test("#4874 — a node with a clear link but an incomplete copy is not ready, and says why", () => {
    const fakeNode = {} as never;
    const r = switchReadiness({ url: "https://master.example" } as never, fakeNode);
    assert.equal(r.ready, false);
    assert.deepEqual(r.reasons, ["this node's copy is not complete yet (its background replication is still going)"]);
    const clear = switchReadiness({ url: "http://192.168.1.10:7777" } as never, fakeNode);
    assert.match(clear.reasons[0]!, /not https, a tailnet address or this machine/);
});

test("#4874 — a refused switch leaves no trace on the board; a switch leaves one", async () => {
    await assert.rejects(takeOver("https://b.example", { restart: false }, null), /not a proxy node/);
    assert.equal(listSwitches().length, 0);
    recordSwitch({ from_machine: "a", from_url: "https://a.example", to_machine: "b", to_url: "https://b.example", rev: 42, by: "boss" });
    const [sw, ...rest] = listSwitches();
    assert.equal(rest.length, 0);
    assert.equal(sw!.from_machine, "a");
    assert.equal(sw!.to_machine, "b");
    assert.equal(sw!.rev, 42);
    assert.equal(sw!.by, "boss");
});

test("#4874 — the board's master and its switches, for the moderator's panel only", async () => {
    const st = await callMethod(testCaller("boss", { kind: "human" }), "master.state", {}) as { machine: string; switches: unknown[] };
    assert.equal(typeof st.machine, "string");
    assert.equal(st.switches.length, 1);
    upsertConsumer({ consumer_id: "bot", kind: "agent" });
    await assert.rejects(callMethod(testCaller("bot", { kind: "agent" }), "master.state", {}));
});
