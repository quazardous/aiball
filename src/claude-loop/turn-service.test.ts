// #999 — the drain tempo (turn:settled re-arm = the `📨Ns` countdown) is
// configurable via `claude_loop.wake_tempo_seconds` → env `CL_WAKE_TEMPO_SEC`,
// read by the TurnService and fed to the turn-machine as `tunnelMs`. Falls
// back to the SSOT 10s (WAKE_COOLDOWN_MS) when unset/invalid.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { getTurnService, resetTurnServiceForTests, TurnService } from "./turn-service.js";
import { turnMachine } from "./turn-machine.js";
import { WAKE_COOLDOWN_MS } from "./wake-machine.js";
import { CL_ENV } from "./env-vars.js";

function tunnelMsOf(): number {
    return getTurnService().getActor().getSnapshot().context.tunnelMs;
}

afterEach(() => {
    delete process.env[CL_ENV.WAKE_TEMPO_SEC];
    resetTurnServiceForTests();
});

test("#999 tunnelMs defaults to WAKE_COOLDOWN_MS when env unset", () => {
    delete process.env[CL_ENV.WAKE_TEMPO_SEC];
    resetTurnServiceForTests();
    assert.equal(tunnelMsOf(), WAKE_COOLDOWN_MS);
});

test("#999 CL_WAKE_TEMPO_SEC overrides the tempo (seconds → ms)", () => {
    process.env[CL_ENV.WAKE_TEMPO_SEC] = "25";
    resetTurnServiceForTests();
    assert.equal(tunnelMsOf(), 25_000);
});

test("#999 invalid / non-positive tempo falls back to the default", () => {
    process.env[CL_ENV.WAKE_TEMPO_SEC] = "0";
    resetTurnServiceForTests();
    assert.equal(tunnelMsOf(), WAKE_COOLDOWN_MS);
    process.env[CL_ENV.WAKE_TEMPO_SEC] = "nope";
    resetTurnServiceForTests();
    assert.equal(tunnelMsOf(), WAKE_COOLDOWN_MS);
});

test("#3257 a service restored from a settled snapshot keeps the tempo, on the same idle anchor", async () => {
    const before = createActor(turnMachine, { input: { tunnelMs: 30 } });
    before.start();
    before.send({ type: "SESSION_START", atMs: 12_345 });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(before.getSnapshot().matches({ no_turn: "settled" }), "the loop was idle and settled when it respawned");
    const snap = before.getPersistedSnapshot();
    before.stop();

    const restored = new TurnService(snap as never);
    const settled: number[] = [];
    restored.getActor().on("turn:settled", (e) => settled.push(e.idleSinceMs));
    await new Promise((r) => setTimeout(r, 200));
    restored.getActor().stop();
    assert.ok(settled.length >= 2, `turn:settled goes on after the restore (got ${settled.length})`);
    assert.ok(settled.every((t) => t === 12_345), "the idle anchor survives the respawn");
});
