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

const { secureLink } = await import("./master-switch.js");
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
