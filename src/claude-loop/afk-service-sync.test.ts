// #649 Slice 4 — afk-service-sync unit tests.
// Run: `npx tsx --test src/claude-loop/afk-service-sync.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afkMarkerExists,
    armAfkViaService,
    clearAfkViaService,
    hydrateAfkServiceFromMarker,
    setAfkInfViaService,
    watchAfkMarker,
} from "./afk-service-sync.js";
import { AfkService } from "./afk-service.js";
import { afkPath } from "./state.js";

function mkSd(): string {
    return mkdtempSync(join(tmpdir(), "afksync-"));
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

test("hydrateAfkServiceFromMarker: file absent → service stays off", () => {
    const sd = mkSd();
    const svc = new AfkService("wait_inf");  // pre-set wrong state
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.getState(), "off");
});

test("hydrateAfkServiceFromMarker: file empty → service off", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "");
    const svc = new AfkService("wait_inf");
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.getState(), "off");
});

test("hydrateAfkServiceFromMarker: file 'inf' → service wait_inf", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "inf\n");
    const svc = new AfkService();
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.getState(), "wait_inf");
    assert.equal(svc.expiryMs(), null);
});

test("hydrateAfkServiceFromMarker: file with future ISO → service wait_10m + expiry", () => {
    const sd = mkSd();
    const expiry = Date.now() + 600_000;
    writeFileSync(afkPath(sd), new Date(expiry).toISOString() + "\n");
    const svc = new AfkService();
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.getState(), "wait_10m");
    assert.equal(svc.expiryMs(), expiry);
});

test("hydrateAfkServiceFromMarker: file with past ISO → service off (expired)", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), new Date(Date.now() - 60_000).toISOString() + "\n");
    const svc = new AfkService("wait_inf");
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.getState(), "off");
});

test("hydrateAfkServiceFromMarker: idempotent — same content, no extra transitions fire", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "inf\n");
    const svc = new AfkService();
    hydrateAfkServiceFromMarker(sd, svc);
    let calls = 0;
    svc.subscribe(() => { calls++; });
    hydrateAfkServiceFromMarker(sd, svc);
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(calls, 0, "Observable<AfkState> idempotent on equal state");
});

test("hydrateAfkServiceFromMarker: mid-countdown expiry rewrite updates expiryMs without firing", () => {
    const sd = mkSd();
    const exp1 = Date.now() + 600_000;
    writeFileSync(afkPath(sd), new Date(exp1).toISOString() + "\n");
    const svc = new AfkService();
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.expiryMs(), exp1);
    let calls = 0;
    svc.subscribe(() => { calls++; });
    const exp2 = exp1 + 60_000;
    writeFileSync(afkPath(sd), new Date(exp2).toISOString() + "\n");
    hydrateAfkServiceFromMarker(sd, svc);
    assert.equal(svc.expiryMs(), exp2, "expiry picked up even when state unchanged");
    assert.equal(calls, 0, "state transition didn't fire (still wait_10m)");
});

test("afkMarkerExists: false when absent, true when present", () => {
    const sd = mkSd();
    assert.equal(afkMarkerExists(sd), false);
    writeFileSync(afkPath(sd), "inf\n");
    assert.equal(afkMarkerExists(sd), true);
    unlinkSync(afkPath(sd));
    assert.equal(afkMarkerExists(sd), false);
});

test("watchAfkMarker: hydrates once at setup even if file pre-exists", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "inf\n");
    const svc = new AfkService();
    const off = watchAfkMarker(sd, svc);
    try {
        assert.equal(svc.getState(), "wait_inf", "initial hydrate ran");
    } finally {
        off();
    }
});

test("watchAfkMarker: picks up cross-process file write", async () => {
    const sd = mkSd();
    const svc = new AfkService();
    const off = watchAfkMarker(sd, svc);
    try {
        assert.equal(svc.getState(), "off");
        writeFileSync(afkPath(sd), "inf\n");
        // fs.watch is async — small wait for the event to land.
        await sleep(150);
        assert.equal(svc.getState(), "wait_inf");
    } finally {
        off();
    }
});

test("watchAfkMarker: picks up file unlink (back to off)", async () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "inf\n");
    const svc = new AfkService();
    const off = watchAfkMarker(sd, svc);
    try {
        assert.equal(svc.getState(), "wait_inf");
        unlinkSync(afkPath(sd));
        await sleep(150);
        assert.equal(svc.getState(), "off");
    } finally {
        off();
    }
});

test("watchAfkMarker: ignores other files in sd", async () => {
    const sd = mkSd();
    const svc = new AfkService("wait_inf");
    writeFileSync(afkPath(sd), "inf\n");
    hydrateAfkServiceFromMarker(sd, svc);
    const off = watchAfkMarker(sd, svc);
    try {
        let calls = 0;
        svc.subscribe(() => { calls++; });
        writeFileSync(join(sd, "some-other-file"), "x\n");
        await sleep(150);
        assert.equal(calls, 0, "writes to other files don't trigger hydrate");
    } finally {
        off();
    }
});

test("watchAfkMarker: unwatch stops further updates", async () => {
    const sd = mkSd();
    const svc = new AfkService();
    const off = watchAfkMarker(sd, svc);
    off();
    writeFileSync(afkPath(sd), "inf\n");
    await sleep(150);
    assert.equal(svc.getState(), "off", "no update after unwatch");
});

test("armAfkViaService: sets service state + writes file with ISO expiry", () => {
    const sd = mkSd();
    const svc = new AfkService();
    const before = Date.now();
    const expiry = armAfkViaService(sd, 600, svc);
    const after = Date.now();
    assert.equal(svc.getState(), "wait_10m");
    assert.equal(svc.expiryMs(), expiry);
    assert.ok(expiry >= before + 600_000 && expiry <= after + 600_000, "expiry ≈ now+10min");
    const content = readFileSync(afkPath(sd), "utf8").trim();
    assert.equal(content, new Date(expiry).toISOString());
});

test("armAfkViaService: mid-countdown re-arm updates both service expiry + file", () => {
    const sd = mkSd();
    const svc = new AfkService();
    armAfkViaService(sd, 600, svc);
    const exp1 = svc.expiryMs();
    const exp2 = armAfkViaService(sd, 300, svc);
    assert.equal(svc.getState(), "wait_10m");
    assert.notEqual(exp2, exp1, "expiry rewritten");
    assert.equal(svc.expiryMs(), exp2);
    const content = readFileSync(afkPath(sd), "utf8").trim();
    assert.equal(content, new Date(exp2).toISOString());
});

test("setAfkInfViaService: sets wait_inf + writes 'inf' to file", () => {
    const sd = mkSd();
    const svc = new AfkService();
    setAfkInfViaService(sd, svc);
    assert.equal(svc.getState(), "wait_inf");
    assert.equal(svc.expiryMs(), null);
    assert.equal(readFileSync(afkPath(sd), "utf8").trim(), "inf");
});

test("clearAfkViaService: sets off + unlinks file", () => {
    const sd = mkSd();
    writeFileSync(afkPath(sd), "inf\n");
    const svc = new AfkService("wait_inf");
    clearAfkViaService(sd, svc);
    assert.equal(svc.getState(), "off");
    assert.equal(svc.expiryMs(), null);
    assert.equal(existsSync(afkPath(sd)), false);
});

test("clearAfkViaService: no-op when file already absent (race-safe)", () => {
    const sd = mkSd();
    const svc = new AfkService();
    clearAfkViaService(sd, svc);
    assert.equal(svc.getState(), "off");
    assert.equal(existsSync(afkPath(sd)), false);
});

test("via-service helpers fire transition events on subscribers", () => {
    const sd = mkSd();
    const svc = new AfkService();
    const seen: string[] = [];
    svc.subscribe((state) => { seen.push(state); });
    armAfkViaService(sd, 600, svc);
    setAfkInfViaService(sd, svc);
    clearAfkViaService(sd, svc);
    assert.deepEqual(seen, ["wait_10m", "wait_inf", "off"]);
});
