/**
 * #633 Slice F — unit tests for the proxy→timer back-channel dispatcher.
 * Each scenario stands up a tmp state-dir, optionally seeds markers, sends
 * a synthetic event, and asserts both the returned verdict + the on-disk
 * marker changes.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afkPath,
    bootCompletePath,
    humanTypingPath,
    paneReadyPath,
    userTookOverPath,
    loopStartTsPath,
} from "./state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "proxy-event-test-"));
}

/** Mark boot as settled : floor elapsed + paneReady + bootComplete sealed. */
function seedPostBoot(sd: string): void {
    // loopStartTs far enough in the past that the 30s floor is over.
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
}

test("#633F dispatch typing post-boot → arms NOT AFK 10m", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "typing", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "typing-armed" });
        // AFK file now has a parseable ISO expiry ~10 min ahead.
        const content = readFileSync(afkPath(sd), "utf8").trim();
        const expiry = new Date(content).getTime();
        assert.ok(Number.isFinite(expiry));
        const delta = expiry - Date.now();
        assert.ok(delta > 595_000 && delta < 605_000, `expiry delta ${delta}ms out of ±5s of 600s`);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch typing during boot → no arm (state.inBootGrace)", () => {
    const sd = tmp();
    try {
        // loop started "now" → still in 30s floor, no bootComplete, no paneReady.
        writeFileSync(loopStartTsPath(sd), String(Date.now()));
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "typing", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "typing-skipped-boot" });
        // AFK file untouched.
        assert.equal(existsSync(afkPath(sd)), false);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch afk_key from off → wait_10m (toggle cycle)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_10m" });
        // AFK file now has a 10m expiry.
        const content = readFileSync(afkPath(sd), "utf8").trim();
        assert.ok(!Number.isNaN(new Date(content).getTime()));
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch afk_key from wait_10m → wait_inf", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        writeFileSync(afkPath(sd), new Date(Date.now() + 600_000).toISOString() + "\n");
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_inf" });
        assert.equal(readFileSync(afkPath(sd), "utf8").trim(), "inf");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch afk_key from wait_inf → off (clears AFK + user-grace)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        writeFileSync(afkPath(sd), "inf\n");
        writeFileSync(userTookOverPath(sd), new Date().toISOString() + "\n");
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "off" });
        assert.equal(existsSync(afkPath(sd)), false);
        // user-grace cleared alongside (atomic NOT AFK ∞ → AFK release).
        assert.equal(existsSync(userTookOverPath(sd)), false);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch marker touch_marker → writes human-typing", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const before = Date.now();
        const v = dispatchProxyEvent(sd, { event: "marker", name: "touch_marker", now_ms: before });
        assert.deepEqual(v, { kind: "marker-touched", name: "touch_marker" });
        assert.ok(existsSync(humanTypingPath(sd)));
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch marker touch_user_grace → writes user-took-over", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "marker", name: "touch_user_grace", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "marker-touched", name: "touch_user_grace" });
        assert.ok(existsSync(userTookOverPath(sd)));
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch marker clear_user_grace → removes user-took-over", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        writeFileSync(userTookOverPath(sd), new Date().toISOString() + "\n");
        const v = dispatchProxyEvent(sd, { event: "marker", name: "clear_user_grace", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "marker-touched", name: "clear_user_grace" });
        assert.equal(existsSync(userTookOverPath(sd)), false);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch unknown event kind → returns unknown verdict, no fs touch", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "unknown_future_kind", now_ms: 0 });
        assert.equal(v.kind, "unknown");
        // AFK file should not have been created.
        assert.equal(existsSync(afkPath(sd)), false);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch unknown marker name → returns unknown verdict", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "marker", name: "future_unknown_marker", now_ms: 0 });
        assert.equal(v.kind, "unknown");
        assert.equal((v as { raw: string }).raw, "marker:future_unknown_marker");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

// #653 step 1 — AFK marker events from the proxy update AfkService.
import { getAfkService, resetAfkServiceForTests } from "./afk-service.js";

test("#653 dispatch set_afk_10m → AfkService.set10m, returns afk-service-set", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        const exp = Date.now() + 600_000;
        const v = dispatchProxyEvent(sd, { event: "marker", name: "set_afk_10m", expiry_ms: exp, now_ms: Date.now() });
        assert.equal(v.kind, "afk-service-set");
        const svc = getAfkService();
        assert.equal(svc.getState(), "wait_10m");
        // Step 2 — armAfkViaService takes seconds-from-now and computes
        // a fresh absolute expiry, so the recorded value may differ from
        // the input event's expiry_ms by up to ~2s (sub-second rounding
        // in the secondsFromNow conversion). Assert within tolerance.
        const recorded = svc.expiryMs();
        assert.ok(recorded !== null && Math.abs(recorded - exp) < 2_000, `expiry within 2s of event expiry_ms`);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 dispatch set_afk_10m without expiry_ms → unknown verdict", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        const v = dispatchProxyEvent(sd, { event: "marker", name: "set_afk_10m", now_ms: Date.now() });
        assert.equal(v.kind, "unknown");
        assert.match((v as { raw: string }).raw, /set_afk_10m.*missing expiry_ms/);
        assert.equal(getAfkService().getState(), "off", "no state change on bad payload");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 dispatch set_afk_inf → AfkService.setInf, returns afk-service-set", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        const v = dispatchProxyEvent(sd, { event: "marker", name: "set_afk_inf", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-service-set", mode: "wait_inf", expiryMs: null });
        const svc = getAfkService();
        assert.equal(svc.getState(), "wait_inf");
        assert.equal(svc.expiryMs(), null);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 dispatch clear_afk → AfkService.setOff, returns afk-service-set", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        getAfkService().setInf();  // start from a non-off state
        const v = dispatchProxyEvent(sd, { event: "marker", name: "clear_afk", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-service-set", mode: "off", expiryMs: null });
        assert.equal(getAfkService().getState(), "off");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 step 2 — dispatcher WRITES the afk file (single-writer contract)", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        const exp = Date.now() + 600_000;
        dispatchProxyEvent(sd, { event: "marker", name: "set_afk_10m", expiry_ms: exp, now_ms: Date.now() });
        // Step 2 flip : the dispatcher's via-service helper now writes
        // the file (replacing the proxy's earlier write). Cross-process
        // readers (hooks, state.ts readAfkState) keep seeing the file.
        assert.equal(existsSync(afkPath(sd)), true, "file written by dispatcher via armAfkViaService");
        const content = readFileSync(afkPath(sd), "utf8").trim();
        assert.match(content, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp persisted");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 step 2 — clear_afk removes the file", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        writeFileSync(afkPath(sd), "inf\n");
        dispatchProxyEvent(sd, { event: "marker", name: "clear_afk", now_ms: Date.now() });
        assert.equal(existsSync(afkPath(sd)), false, "file removed by dispatcher via clearAfkViaService");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#653 step 2 — set_afk_inf writes 'inf' content", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        dispatchProxyEvent(sd, { event: "marker", name: "set_afk_inf", now_ms: Date.now() });
        assert.equal(readFileSync(afkPath(sd), "utf8").trim(), "inf");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F formatVerdictLogLine covers every verdict variant", () => {
    assert.equal(formatVerdictLogLine({ kind: "typing-armed" }), "proxy-event: typing → armed NOT AFK 10m");
    assert.equal(formatVerdictLogLine({ kind: "typing-skipped-boot" }), "proxy-event: typing during boot → no arm (state.inBootGrace)");
    assert.equal(formatVerdictLogLine({ kind: "afk-toggled", nextMode: "wait_10m" }), "proxy-event: afk_key → toggled to wait_10m");
    assert.equal(formatVerdictLogLine({ kind: "marker-touched", name: "touch_marker" }), "proxy-event: marker 'touch_marker' applied");
    assert.match(formatVerdictLogLine({ kind: "afk-service-set", mode: "wait_10m", expiryMs: 1_000_000_000_000 }), /AfkService → wait_10m \(expiry=.*\)/);
    assert.equal(formatVerdictLogLine({ kind: "afk-service-set", mode: "off", expiryMs: null }), "proxy-event: AfkService → off");
    assert.equal(formatVerdictLogLine({ kind: "unknown", raw: "keystroke:foo" }), "proxy-event: unknown 'keystroke:foo'");
    assert.equal(formatVerdictLogLine({ kind: "error", message: "boom" }), "proxy-event handler error: boom");
});
