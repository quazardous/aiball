// #999 — the drain tempo (turn:settled re-arm = the `📨Ns` countdown) is
// configurable via `claude_loop.wake_tempo_seconds` → env `CL_WAKE_TEMPO_SEC`,
// read by the TurnService and fed to the turn-machine as `tunnelMs`. Falls
// back to the SSOT 10s (WAKE_COOLDOWN_MS) when unset/invalid.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getTurnService, resetTurnServiceForTests } from "./turn-service.js";
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
