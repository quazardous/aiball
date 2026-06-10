/**
 * #633 Slice F — unit tests for the proxy→timer back-channel dispatcher.
 * Each scenario stands up a tmp state-dir, optionally seeds markers, sends
 * a synthetic event, and asserts both the returned verdict + the on-disk
 * marker changes.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopStartTsPath } from "./state.js";
import {
    getIpcState,
    setIpcAfk,
    setIpcBootComplete,
    setIpcPaneReady,
    resetIpcStateForTests,
} from "./ipc-state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";
import { getAfkService, resetAfkServiceForTests } from "./afk-service.js";

// #733 V2 — also resets `ipcState` so `setIpcPaneReady` from a previous
// `seedPostBoot` doesn't leak into the next test. Also resets the
// AfkService singleton so the actor doesn't carry state across tests
// (#876 — AfkController is the source of truth for the AFK SM).
function tmp(): string {
    resetIpcStateForTests();
    resetAfkServiceForTests();
    return mkdtempSync(join(tmpdir(), "proxy-event-test-"));
}

/** Mark boot as settled : floor elapsed + paneReady + bootComplete sealed.
 *  #840 `4z59jt` — IPC seul. */
function seedPostBoot(sd: string): void {
    // loopStartTs far enough in the past that the 30s floor is over.
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
}

test("#633F dispatch typing post-boot → arms NOT AFK 10m (ipc)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "typing", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "typing-armed" });
        // #840 — AFK is IPC-only ; expect a fresh wait_10m expiry ~10 min ahead.
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        const delta = (ipc.afkExpiryMs ?? 0) - Date.now();
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
        // IPC untouched.
        assert.equal(getIpcState().afkMode, null);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#876 dispatch afk_key from off → pending_10m (actor in pending, committed unchanged)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_10m" });
        // Committed afkMode UNTOUCHED during the debounce window — the
        // actor is in `pending_10m` so context.afkMode is still "off".
        const snap = getAfkService().getActor().getSnapshot();
        assert.equal(snap.value, "pending_10m");
        assert.equal(snap.context.afkMode, "off");
        assert.ok(snap.context.dispExpiryMs !== null, "dispExpiryMs hint set");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#876 dispatch afk_key from wait_10m → pending_inf (committed wait_10m unchanged during debounce)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const expiryMs = Date.now() + 600_000;
        // Seed BOTH actor (sole source of truth) AND ipc (back-compat reads).
        getAfkService().set10m(expiryMs);
        setIpcAfk("wait_10m", expiryMs);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "wait_inf" });
        const snap = getAfkService().getActor().getSnapshot();
        assert.equal(snap.value, "pending_inf");
        // Committed unchanged
        assert.equal(snap.context.afkMode, "wait_10m");
        assert.equal(snap.context.afkExpiryMs, expiryMs);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#876 dispatch afk_key from wait_inf → pending_off (committed wait_inf unchanged)", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        getAfkService().setInf();
        setIpcAfk("wait_inf", null);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "afk_key", now_ms: Date.now() });
        assert.deepEqual(v, { kind: "afk-toggled", nextMode: "off" });
        const snap = getAfkService().getActor().getSnapshot();
        assert.equal(snap.value, "pending_off");
        assert.equal(snap.context.afkMode, "wait_inf");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#633F dispatch marker touch_marker → stamps humanTypingAtMs in ipc", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const before = Date.now();
        const v = dispatchProxyEvent(sd, { event: "marker", name: "touch_marker", now_ms: before });
        assert.deepEqual(v, { kind: "marker-touched", name: "touch_marker" });
        const ts = getIpcState().humanTypingAtMs;
        assert.ok(ts !== null && ts >= before - 1, "humanTypingAtMs stamped");
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

test("#633F dispatch unknown event kind → returns unknown verdict, ipc untouched", () => {
    const sd = tmp();
    try {
        seedPostBoot(sd);
        const v = dispatchProxyEvent(sd, { event: "keystroke", kind: "unknown_future_kind", now_ms: 0 });
        assert.equal(v.kind, "unknown");
        assert.equal(getIpcState().afkMode, null);
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

test("#840 — dispatcher stamps ipc afkMode on set_afk_10m (no file)", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        resetIpcStateForTests();
        const exp = Date.now() + 600_000;
        dispatchProxyEvent(sd, { event: "marker", name: "set_afk_10m", expiry_ms: exp, now_ms: Date.now() });
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        assert.ok(ipc.afkExpiryMs !== null && Math.abs(ipc.afkExpiryMs - exp) < 2_000);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#840 — clear_afk stamps ipc afkMode off (no file)", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        resetIpcStateForTests();
        setIpcAfk("wait_inf", null);
        dispatchProxyEvent(sd, { event: "marker", name: "clear_afk", now_ms: Date.now() });
        assert.equal(getIpcState().afkMode, "off");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#840 — set_afk_inf stamps ipc afkMode wait_inf (no file)", () => {
    const sd = tmp();
    try {
        resetAfkServiceForTests();
        resetIpcStateForTests();
        dispatchProxyEvent(sd, { event: "marker", name: "set_afk_inf", now_ms: Date.now() });
        assert.equal(getIpcState().afkMode, "wait_inf");
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
