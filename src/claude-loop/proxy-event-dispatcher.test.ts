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
    afkPendingPath,
    bootCompletePath,
    commitAfkPendingIfDue,
    humanTypingPath,
    loopStartTsPath,
    readAfkPending,
} from "./state.js";
import { setIpcPaneReady, resetIpcStateForTests } from "./ipc-state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";

// #733 V2 — also resets `ipcState` so `setIpcPaneReady` from a previous
// `seedPostBoot` doesn't leak into the next test.
function tmp(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "proxy-event-test-"));
}

/** Mark boot as settled : floor elapsed + paneReady + bootComplete sealed. */
function seedPostBoot(sd: string): void {
    // loopStartTs far enough in the past that the 30s floor is over.
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
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

test("#633F + #751 s4grb2 dispatch afk_key from off → wait_10m (pending, then committed)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_10m" });
        // Debounce : the AFK file is NOT yet written ; the pending file is.
        assert.equal(existsSync(afkPath(sd)), false, "afk file unchanged during debounce window");
        const pending = readAfkPending(sd);
        assert.ok(pending, "afk-pending file written");
        assert.equal(pending!.kind, "wait_10m");
        assert.ok(pending!.commit_at_ms > Date.now(), "commit_at_ms in the future");
        // Backdate commit_at_ms so commit fires immediately.
        writeFileSync(afkPendingPath(sd), JSON.stringify({ ...pending!, commit_at_ms: Date.now() - 1 }));
        const did = commitAfkPendingIfDue(sd);
        assert.equal(did, true);
        const content = readFileSync(afkPath(sd), "utf8").trim();
        assert.ok(!Number.isNaN(new Date(content).getTime()), "afk file now has a 10m expiry");
        assert.equal(existsSync(afkPendingPath(sd)), false, "pending cleared after commit");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F + #751 s4grb2 dispatch afk_key from wait_10m → wait_inf (pending, then committed)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        writeFileSync(afkPath(sd), new Date(Date.now() + 600_000).toISOString() + "\n");
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_inf" });
        const pending = readAfkPending(sd);
        assert.ok(pending);
        assert.equal(pending!.kind, "wait_inf");
        writeFileSync(afkPendingPath(sd), JSON.stringify({ ...pending!, commit_at_ms: Date.now() - 1 }));
        commitAfkPendingIfDue(sd);
        assert.equal(readFileSync(afkPath(sd), "utf8").trim(), "inf");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F + #751 s4grb2 dispatch afk_key from wait_inf → off (pending, then committed, clears AFK)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        writeFileSync(afkPath(sd), "inf\n");
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "off" });
        // Pre-commit : `afk` still says "inf" (the debounce hasn't fired yet).
        assert.equal(readFileSync(afkPath(sd), "utf8").trim(), "inf");
        const pending = readAfkPending(sd);
        assert.ok(pending);
        assert.equal(pending!.kind, "off");
        writeFileSync(afkPendingPath(sd), JSON.stringify({ ...pending!, commit_at_ms: Date.now() - 1 }));
        commitAfkPendingIfDue(sd);
        assert.equal(existsSync(afkPath(sd)), false);
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

test("#633F + #745 dispatch touch_user_grace / clear_user_grace → marker-touched no-op", () => {
    // #745 phase B : user-grace machinery dropped (AFK SM owns the
    // "human present" signal). The dispatcher still accepts the marker
    // names for forward-compat (the proxy may still emit them), but
    // they're pure no-ops — no file is written/removed.
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const touch = dispatchProxyEvent(sd, { event: "marker", name: "touch_user_grace", now_ms: Date.now() });
        assert.deepEqual(touch, { kind: "marker-touched", name: "touch_user_grace" });
        const clear = dispatchProxyEvent(sd, { event: "marker", name: "clear_user_grace", now_ms: Date.now() });
        assert.deepEqual(clear, { kind: "marker-touched", name: "clear_user_grace" });
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

// #652 Slice 3 — hook events from spawn-per-call hook subprocesses.
import { getHookService, resetHookServiceForTests, type HookEvent } from "./hook-service.js";

test("#652 dispatch hook SessionStart → HookService.emit, verdict carries the event", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "SessionStart", source: "resume", at_ms: 1_000 });
        assert.equal(v.kind, "hook-event");
        assert.deepEqual((v as { hookEvent: HookEvent }).hookEvent, { kind: "SessionStart", source: "resume", at_ms: 1_000 });
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0], { kind: "SessionStart", source: "resume", at_ms: 1_000 });
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 dispatch hook SessionStart with unknown source → unknown verdict", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "SessionStart", source: "weird", at_ms: 1_000 });
        assert.equal(v.kind, "unknown");
        assert.match((v as { raw: string }).raw, /SessionStart.*bad source weird/);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 dispatch hook Stop → HookService.emit", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "Stop", at_ms: 2_000 });
        assert.equal(v.kind, "hook-event");
        assert.deepEqual(seen[0], { kind: "Stop", at_ms: 2_000 });
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 dispatch hook PreToolUse with tool_name → HookService.emit", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "PreToolUse", tool_name: "Bash", at_ms: 3_000 });
        assert.equal(v.kind, "hook-event");
        assert.deepEqual(seen[0], { kind: "PreToolUse", tool_name: "Bash", at_ms: 3_000 });
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 dispatch hook PreToolUse without tool_name → unknown verdict", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "PreToolUse", at_ms: 3_000 });
        assert.equal(v.kind, "unknown");
        assert.match((v as { raw: string }).raw, /PreToolUse.*missing tool_name/);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 Slice 6 — dispatch hook UserPromptSubmit (human) → HookService.emit", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        const v = dispatchProxyEvent(sd, { event: "hook", kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 4_000 });
        assert.equal(v.kind, "hook-event");
        assert.deepEqual(seen[0], { kind: "UserPromptSubmit", from_auto_wake: false, at_ms: 4_000 });
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 Slice 6 — dispatch hook UserPromptSubmit (auto-wake) → from_auto_wake true", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        dispatchProxyEvent(sd, { event: "hook", kind: "UserPromptSubmit", from_auto_wake: true, at_ms: 5_000 });
        assert.equal(seen.length, 1);
        assert.equal((seen[0] as Extract<HookEvent, { kind: "UserPromptSubmit" }>).from_auto_wake, true);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 Slice 6 — dispatch hook UserPromptSubmit defaults from_auto_wake to false when missing", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        dispatchProxyEvent(sd, { event: "hook", kind: "UserPromptSubmit", at_ms: 5_000 });
        assert.equal(seen.length, 1);
        assert.equal((seen[0] as Extract<HookEvent, { kind: "UserPromptSubmit" }>).from_auto_wake, false, "missing → false (legitimately a human submission)");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#652 hook event defaults at_ms to now when missing", () => {
    const sd = tmp();
    try {
        resetHookServiceForTests();
        const seen: HookEvent[] = [];
        getHookService().subscribe((e) => { seen.push(e); });
        const before = Date.now();
        dispatchProxyEvent(sd, { event: "hook", kind: "Stop" });
        const after = Date.now();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].at_ms >= before && seen[0].at_ms <= after, "at_ms within now() bracket");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F formatVerdictLogLine covers every verdict variant", () => {
    assert.equal(formatVerdictLogLine({ kind: "typing-armed" }), "proxy-event: typing → armed NOT AFK 10m");
    assert.equal(formatVerdictLogLine({ kind: "typing-skipped-boot" }), "proxy-event: typing during boot → no arm (state.inBootGrace)");
    assert.equal(formatVerdictLogLine({ kind: "afk-toggled", nextMode: "wait_10m" }), "proxy-event: afk_key → toggled to wait_10m");
    assert.equal(formatVerdictLogLine({ kind: "marker-touched", name: "touch_marker" }), "proxy-event: marker 'touch_marker' applied");
    assert.match(formatVerdictLogLine({ kind: "afk-service-set", mode: "wait_10m", expiryMs: 1_000_000_000_000 }), /AfkService → wait_10m \(expiry=.*\)/);
    assert.equal(formatVerdictLogLine({ kind: "afk-service-set", mode: "off", expiryMs: null }), "proxy-event: AfkService → off");
    assert.equal(formatVerdictLogLine({ kind: "hook-event", hookEvent: { kind: "SessionStart", source: "resume", at_ms: 0 } }), "proxy-event: HookService ← SessionStart (source=resume)");
    assert.equal(formatVerdictLogLine({ kind: "hook-event", hookEvent: { kind: "Stop", at_ms: 0 } }), "proxy-event: HookService ← Stop");
    assert.equal(formatVerdictLogLine({ kind: "hook-event", hookEvent: { kind: "PreToolUse", tool_name: "Bash", at_ms: 0 } }), "proxy-event: HookService ← PreToolUse (tool=Bash)");
    assert.equal(formatVerdictLogLine({ kind: "unknown", raw: "keystroke:foo" }), "proxy-event: unknown 'keystroke:foo'");
    assert.equal(formatVerdictLogLine({ kind: "error", message: "boom" }), "proxy-event handler error: boom");
});
