// #3157 — `state_since` moves when the phase changes, and only then: a loop
// that says `boot` then `idle` shows idle since its boot ended; the same phase
// again (a heartbeat) keeps the date.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3157-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));
const { upsertConsumer, setConsumerState, getConsumer } = await import("../db.js");

const since = () => getConsumer("looper")!.state_since;
const tick = () => new Promise((r) => setTimeout(r, 5));

test("idle, then boot, then idle: state_since follows each change, not a repeat", async () => {
    upsertConsumer({ consumer_id: "looper", kind: "agent" });
    setConsumerState("looper", "idle");
    const firstIdle = since();
    await tick();
    setConsumerState("looper", "idle");
    assert.equal(since(), firstIdle, "a heartbeat with the same phase keeps the date");
    await tick();
    setConsumerState("looper", "boot");
    const boot = since();
    assert.notEqual(boot, firstIdle, "a new run's boot is a change");
    assert.equal(getConsumer("looper")!.state, "boot");
    await tick();
    setConsumerState("looper", "idle");
    assert.ok(since()! > boot!, "idle since the boot ended, not since the previous run");
});
