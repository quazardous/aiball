// #649 Slice 4 — afk-service-sync unit tests.
// Run: `npx tsx --test src/claude-loop/afk-service-sync.test.ts`.
//
// #840 `4z59jt` — david "vire tout marker fichier". afk-service-sync ne
// touche plus aucun fichier. On vérifie uniquement que les helpers
// *ViaService propagent à AfkService observable + ipcState.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    armAfkViaService,
    clearAfkViaService,
    setAfkInfViaService,
} from "./afk-service-sync.js";
import { AfkService } from "./afk-service.js";
import { getIpcState, resetIpcStateForTests } from "./ipc-state.js";

function setUp(): { svc: AfkService; sd: string } {
    resetIpcStateForTests();
    return { svc: new AfkService(), sd: "/tmp/afk-test-sd" };
}

test("armAfkViaService: service wait_10m + ipcState mirrored", () => {
    const { svc, sd } = setUp();
    const before = Date.now();
    const expiry = armAfkViaService(sd, 600, svc);
    const after = Date.now();
    assert.equal(svc.getState(), "wait_10m");
    assert.equal(svc.expiryMs(), expiry);
    assert.ok(expiry >= before + 600_000 && expiry <= after + 600_000, "expiry ≈ now+10min");
    const ipc = getIpcState();
    assert.equal(ipc.afkMode, "wait_10m");
    assert.equal(ipc.afkExpiryMs, expiry);
});

test("armAfkViaService: mid-countdown re-arm updates expiry", () => {
    const { svc, sd } = setUp();
    armAfkViaService(sd, 600, svc);
    const exp1 = svc.expiryMs();
    const exp2 = armAfkViaService(sd, 300, svc);
    assert.equal(svc.getState(), "wait_10m");
    assert.notEqual(exp2, exp1, "expiry rewritten");
    assert.equal(svc.expiryMs(), exp2);
    assert.equal(getIpcState().afkExpiryMs, exp2);
});

test("setAfkInfViaService: service wait_inf + ipcState mirrored", () => {
    const { svc, sd } = setUp();
    setAfkInfViaService(sd, svc);
    assert.equal(svc.getState(), "wait_inf");
    assert.equal(svc.expiryMs(), null);
    const ipc = getIpcState();
    assert.equal(ipc.afkMode, "wait_inf");
    assert.equal(ipc.afkExpiryMs, null);
});

test("clearAfkViaService: service off + ipcState off", () => {
    const { svc, sd } = setUp();
    setAfkInfViaService(sd, svc);
    clearAfkViaService(sd, svc);
    assert.equal(svc.getState(), "off");
    assert.equal(svc.expiryMs(), null);
    const ipc = getIpcState();
    assert.equal(ipc.afkMode, "off");
    assert.equal(ipc.afkExpiryMs, null);
});

test("clearAfkViaService: idempotent when already off", () => {
    const { svc, sd } = setUp();
    clearAfkViaService(sd, svc);
    assert.equal(svc.getState(), "off");
    assert.equal(getIpcState().afkMode, "off");
});

test("via-service helpers fire transition events on subscribers", () => {
    const { svc, sd } = setUp();
    const states: string[] = [];
    svc.subscribe((s) => { states.push(s); });
    armAfkViaService(sd, 600, svc);
    setAfkInfViaService(sd, svc);
    clearAfkViaService(sd, svc);
    // Subscribers see the live transitions only (no replay) : wait_10m → wait_inf → off.
    assert.deepEqual(states, ["wait_10m", "wait_inf", "off"]);
});
