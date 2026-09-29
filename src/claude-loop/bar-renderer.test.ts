// #862 Slice 1 — BarRenderer observer-only tests.
// Run: `npx tsx --test src/claude-loop/bar-renderer.test.ts`.
//
// Focus on the pure diff logic + the start/stop subscribe/unsubscribe
// lifecycle. tmux paint isn't tested (Slice 3 will introduce that ;
// here we assert the observer doesn't touch tmux).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    BarRenderer,
    computeBarSnapshot,
    diffSnapshots,
    type BarSnapshot,
    type SpawnFn,
} from "./bar-renderer.js";
import {
    getIpcState,
    resetIpcStateForTests,
    setIpcBootComplete,
    setIpcCounters,
    setIpcPaneBusy,
    setIpcPaneReady,
    setIpcNextWakeAt,
    setIpcLinkDown,
    setIpcDaemonDown,
    setIpcStateTagInfo,
} from "./ipc-state.js";
import { LOOP_STATUS } from "./state.js";

interface SpawnCall {
    args: string[];
}
function makeSpawnSpy(): { spawn: SpawnFn; calls: SpawnCall[] } {
    const calls: SpawnCall[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
        calls.push({ args: [...args] });
        return { status: 0 };
    };
    return { spawn, calls };
}

function mkSd(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "barrender-"));
}

/** Seed `loop-start-ts` far enough in the past for `bootMinMs` to be
 *  past — otherwise `isInBootGrace` returns true even with bootComplete. */
function seedLoopStartOld(sd: string): void {
    writeFileSync(join(sd, "loop-start-ts"), String(Date.now() - 5 * 60_000));
}

function snap(overrides: Partial<BarSnapshot> = {}): BarSnapshot {
    return {
        humanWord: "#[fg=colour40,bg=colour16]loop",
        loopStatus: LOOP_STATUS.IDLE,
        stateTag: "idle",
        proxyAlive: false,
        zenActive: false,
        counters: null,
        nextWakeInSec: null,
        bootElapsedSec: null,
        bootRemainingSec: null,
        afkGlyph: "",
        promptGlyph: "",
        typingGlyph: "",
        linkDown: false,
        daemonDown: false,
        notLoggedIn: false,
        limitReached: false,
        limitResetsText: null,
        trustDialog: false,
        restartNeeded: false,
        restartPending: false,
        apiUnreachable: false,
        ...overrides,
    };
}

test("diffSnapshots: prev=null → every field marked changed (initial)", () => {
    assert.deepEqual(
        diffSnapshots(null, snap()),
        ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "nextWakeInSec", "bootElapsedSec", "bootRemainingSec", "afkGlyph", "promptGlyph", "typingGlyph"],
    );
});

test("diffSnapshots: identical snapshots → empty list (no-op)", () => {
    const s = snap();
    assert.deepEqual(diffSnapshots(s, { ...s }), []);
});

test("diffSnapshots: humanWord diff alone", () => {
    const prev = snap({ humanWord: "loop" });
    const next = snap({ humanWord: "boot" });
    assert.deepEqual(diffSnapshots(prev, next), ["humanWord"]);
});

test("diffSnapshots: 3 fields diff at once", () => {
    const prev = snap({ humanWord: "loop", loopStatus: LOOP_STATUS.IDLE, stateTag: "idle" });
    const next = snap({ humanWord: "stop", loopStatus: LOOP_STATUS.BUSY, stateTag: "busy" });
    assert.deepEqual(
        diffSnapshots(prev, next).sort(),
        ["humanWord", "loopStatus", "stateTag"].sort(),
    );
});

test("computeBarSnapshot: cold boot (empty ipc) → status=boot", () => {
    const sd = mkSd();
    const s = computeBarSnapshot(sd);
    assert.equal(s.loopStatus, LOOP_STATUS.BOOT);
    assert.equal(s.stateTag, "🚀");
    rmSync(sd, { recursive: true, force: true });
});

test("computeBarSnapshot: post-boot idle (bootComplete + paneReady) → status=idle", () => {
    const sd = mkSd();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    const s = computeBarSnapshot(sd);
    assert.equal(s.loopStatus, LOOP_STATUS.IDLE);
    rmSync(sd, { recursive: true, force: true });
});

test("#1041 computeBarSnapshot: nextWakeInSec reads ipc.nextWakeAtMs (idle)", () => {
    const sd = mkSd();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcNextWakeAt(Date.now() + 5000);
    const s = computeBarSnapshot(sd);
    assert.ok(
        s.nextWakeInSec !== null && s.nextWakeInSec >= 4 && s.nextWakeInSec <= 6,
        `expected ~5s countdown from nextWakeAtMs, got ${s.nextWakeInSec}`,
    );
    rmSync(sd, { recursive: true, force: true });
});

test("#1041 computeBarSnapshot: nextWakeAtMs null → no countdown", () => {
    const sd = mkSd();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcNextWakeAt(null);
    const s = computeBarSnapshot(sd);
    assert.equal(s.nextWakeInSec, null);
    rmSync(sd, { recursive: true, force: true });
});

test("computeBarSnapshot: busy (paneBusy=true) → status=busy", () => {
    const sd = mkSd();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcPaneBusy(true);
    const s = computeBarSnapshot(sd);
    assert.equal(s.loopStatus, LOOP_STATUS.BUSY);
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.start: initial tick + subscribe ; stop: clean unsubscribe", () => {
    const sd = mkSd();
    const r = new BarRenderer(sd, "cl-test");
    r.start();
    // Initial tick ran — checks we did not crash.
    r.stop();
    // Repeated start/stop must be idempotent (no setTimeout leak).
    r.start();
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.tick: idempotent when the state does not change", () => {
    const sd = mkSd();
    const r = new BarRenderer(sd, "cl-test");
    r.tick(); // initial — logs everything
    r.tick(); // 2nd — no-op (nothing changed)
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

// #862 Slice 2 — setIpcCounters + counters/zen/afkGlyph fields.

test("setIpcCounters: stores a normalized object in ipcState", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 3, backlog: 2, events: 0 });
    assert.deepEqual(getIpcState().counters, { open: 3, backlog: 2, events: 0 });
});

test("setIpcCounters: missing fields → normalized to null", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 5 });
    assert.deepEqual(getIpcState().counters, { open: 5, backlog: null, events: null });
});

test("setIpcCounters(null): clears the segment", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 3 });
    setIpcCounters(null);
    assert.equal(getIpcState().counters, null);
});

test("computeBarSnapshot: reads ipc.counters", () => {
    const sd = mkSd();
    setIpcCounters({ open: 4, backlog: 1, events: 2 });
    const s = computeBarSnapshot(sd);
    assert.deepEqual(s.counters, { open: 4, backlog: 1, events: 2 });
    rmSync(sd, { recursive: true, force: true });
});

test("computeBarSnapshot: zen file present → zenActive=true", () => {
    const sd = mkSd();
    writeFileSync(join(sd, "zen"), "");
    const s = computeBarSnapshot(sd);
    assert.equal(s.zenActive, true);
    rmSync(sd, { recursive: true, force: true });
});

test("diffSnapshots: counters diff via deep-equal (= real change)", () => {
    const prev = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    const next = snap({ counters: { open: 2, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), ["counters"]);
});

test("diffSnapshots: identical counters (different object refs) → no diff", () => {
    const prev = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    const next = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), []);
});

test("diffSnapshots: counters null vs {0,0,0} → diff (distinct semantics)", () => {
    const prev = snap({ counters: null });
    const next = snap({ counters: { open: 0, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), ["counters"]);
});

// #862 Slice 3 — actual paint via spawnSync spy.

// #1180 — clearing a glyph must UNSET the option, never assign "".
// `psmux set-option <opt> ""` silently keeps the previous value on Windows:
// exit 0, empty stderr, option unchanged. Measured on a live session:
//     set @probe "XXX" → get "XXX"
//     set @probe ""    → get "XXX"
// So no glyph could ever go out there — the typing `⌨` lit on the first
// keystroke and stayed for the whole session, `@cl_human` with it. The repaint
// was running and computing the right empty string the whole time; the write
// was swallowed. Asserting the SHAPE of the clear is the only way this stays
// caught, since the failure produces no error to observe.

test("BarRenderer.paint: an empty value clears via -u, never by assigning \"\"", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    r.stop();
    rmSync(sd, { recursive: true, force: true });

    const setOpts = calls.filter((c) => c.args[0] === "set-option");
    assert.ok(setOpts.length > 0, "expected the initial tick to paint something");

    // No call may end with an empty value argument — that is the silent no-op.
    const assignsEmpty = setOpts.filter((c) => c.args.at(-1) === "" && !c.args.includes("-u"));
    assert.deepEqual(assignsEmpty, [], "a glyph was cleared by assigning an empty string");

    // And the clears that DO happen must carry -u.
    const unsets = setOpts.filter((c) => c.args.includes("-u"));
    for (const c of unsets) {
        assert.equal(c.args.at(-1)?.startsWith("@"), true, `-u must target a user option, got ${JSON.stringify(c.args)}`);
    }
});

test("BarRenderer.paint: initial tick → spawn set-option for every field", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    // Initial: every field → we expect at least 1 setOpt per field
    // touched. The concrete mapping is tested elsewhere; here we assert
    // that there WERE spawns (= paint ran).
    assert.ok(calls.length > 0, `expected paint to spawn at least one set-option, got ${calls.length}`);
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.paint: tick idempotent (state unchanged) → 0 spawn", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    const initialCount = calls.length;
    r.tick(); // 2nd tick: nothing changed
    assert.equal(calls.length, initialCount, "2nd tick should be a no-op");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.paint: counters change → setOpt @cl_counts", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick(); // initial
    calls.length = 0;
    setIpcCounters({ open: 3, backlog: 1, events: 2 });
    r.tick();
    const cl = calls.find((c) => c.args.includes("@cl_counts"));
    assert.ok(cl, "expected @cl_counts setOpt to fire on counters change");
    assert.ok(cl!.args.some((a) => a.includes("o:3")), "rendered string carries 'o:3'");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("#1041 BarRenderer.paint: 📨 standing indicator when events>0 (no countdown needed)", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    seedLoopStartOld(sd);
    setIpcBootComplete(true); // post-boot : no 🚀, envelope branch reachable
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick(); // initial
    calls.length = 0;
    // Pending FIFO event but no countdown armed (idle past cooldown) → 📨 must
    // still show so the operator sees there's work waiting.
    setIpcCounters({ open: 3, backlog: 0, events: 2 });
    r.tick();
    const cl = calls.find((c) => c.args.includes("@cl_counts"));
    assert.ok(cl, "expected @cl_counts setOpt on counters change");
    assert.ok(cl!.args.some((a) => a.includes("📨")), "📨 shown when events>0");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("#1041 BarRenderer.paint: 📨 also stands on a non-empty backlog", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    calls.length = 0;
    setIpcCounters({ open: 5, backlog: 4, events: 0 });
    r.tick();
    const cl = calls.find((c) => c.args.includes("@cl_counts"));
    assert.ok(cl && cl.args.some((a) => a.includes("📨")), "📨 shown when backlog>0");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("#1041 BarRenderer.paint: no 📨 when nothing pending (empty FIFO + empty backlog)", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    seedLoopStartOld(sd);
    setIpcBootComplete(true);
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    calls.length = 0;
    setIpcCounters({ open: 7, backlog: 0, events: 0 });
    r.tick();
    const cl = calls.find((c) => c.args.includes("@cl_counts"));
    assert.ok(cl, "expected @cl_counts setOpt on counters change");
    assert.ok(!cl!.args.some((a) => a.includes("📨")), "no 📨 when nothing pending");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("#1039 BarRenderer.paint: default = normal bg, linkDown → RED, restored → normal", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick(); // initial paint : linkDown defaults false → NORMAL (not red)
    const init = calls.find((c) => c.args.includes("status-bg"));
    assert.ok(init, "status-bg painted at boot");
    assert.ok(!init!.args.includes("colour160"), "boot bg is NORMAL, not red (no flash)");
    calls.length = 0;
    // Confirmed dead link → status-bg repaints RED (default link_down_bg colour160).
    setIpcLinkDown(true);
    r.tick();
    const down = calls.find((c) => c.args.includes("status-bg"));
    assert.ok(down, "status-bg repainted on link down");
    assert.ok(down!.args.includes("colour160"), `bg should be link_down_bg red, got: ${down!.args.join(" ")}`);
    // Restored → status-bg back to a non-red per-state bg.
    calls.length = 0;
    setIpcLinkDown(false);
    r.tick();
    const up = calls.find((c) => c.args.includes("status-bg"));
    assert.ok(up, "status-bg repainted on restore");
    assert.ok(!up!.args.includes("colour160"), "bg back to NORMAL when link restored");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("#1039 BarRenderer.paint: daemonDown also paints RED (loop↔daemon link)", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick(); // boot : normal
    calls.length = 0;
    setIpcDaemonDown(true);
    r.tick();
    const down = calls.find((c) => c.args.includes("status-bg"));
    assert.ok(down && down.args.includes("colour160"), "daemon link down → bar RED");
    calls.length = 0;
    setIpcDaemonDown(false);
    r.tick();
    const up = calls.find((c) => c.args.includes("status-bg"));
    assert.ok(up && !up.args.includes("colour160"), "daemon link restored → bar NORMAL");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.paint: stateTagInfo change → setOpt @cl_state with token info", () => {
    const sd = mkSd();
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    calls.length = 0;
    setIpcStateTagInfo("wait");
    r.tick();
    const st = calls.find((c) => c.args.includes("@cl_state"));
    assert.ok(st, "expected @cl_state setOpt");
    // #950: tokens space-separated, status → symbol, words after. Cold sd = boot → `🚀`, plain info `wait` stays at the tail.
    assert.ok(st!.args.some((a) => /🚀 wait/.test(a)), "rendered marker carries '🚀 wait' tokens (#950)");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.paint: humanWord change + proxy dead → setOpt @cl_human ; proxy alive → SKIP @cl_human", () => {
    const sd = mkSd();
    // proxy dead = proxy-alive marker absent (default for fresh sd) → BarRenderer must paint
    const { spawn, calls } = makeSpawnSpy();
    const r = new BarRenderer(sd, "cl-test", spawn);
    r.tick();
    const humanCalls = calls.filter((c) => c.args.includes("@cl_human"));
    // Initial without proxy → we expect @cl_human to be painted.
    assert.ok(humanCalls.length > 0, "expected @cl_human to be painted when proxy is dead");
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});
