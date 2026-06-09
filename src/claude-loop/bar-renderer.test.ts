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
} from "./bar-renderer.js";
import {
    getIpcState,
    resetIpcStateForTests,
    setIpcBootComplete,
    setIpcCounters,
    setIpcPaneBusy,
    setIpcPaneReady,
} from "./ipc-state.js";
import { LOOP_STATUS } from "./state.js";

function mkSd(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "barrender-"));
}

/** Seed `loop-start-ts` far enough in the past for `bootMinMs` to be
 *  past — sinon `isInBootGrace` retourne true même avec bootComplete. */
function seedLoopStartOld(sd: string): void {
    writeFileSync(join(sd, "loop-start-ts"), String(Date.now() - 5 * 60_000));
}

function snap(overrides: Partial<BarSnapshot> = {}): BarSnapshot {
    return {
        humanWord: "#[fg=colour40,bg=colour16]loop",
        loopStatus: LOOP_STATUS.IDLE,
        stateTag: "[idle]",
        proxyAlive: false,
        zenActive: false,
        counters: null,
        afkChipStr: "",
        ...overrides,
    };
}

test("diffSnapshots: prev=null → tous les champs marqués changed (initial)", () => {
    assert.deepEqual(
        diffSnapshots(null, snap()),
        ["humanWord", "loopStatus", "stateTag", "proxyAlive", "zenActive", "counters", "afkChipStr"],
    );
});

test("diffSnapshots: snapshots identiques → liste vide (no-op)", () => {
    const s = snap();
    assert.deepEqual(diffSnapshots(s, { ...s }), []);
});

test("diffSnapshots: humanWord diff seul", () => {
    const prev = snap({ humanWord: "loop" });
    const next = snap({ humanWord: "boot" });
    assert.deepEqual(diffSnapshots(prev, next), ["humanWord"]);
});

test("diffSnapshots: 3 champs diff en même temps", () => {
    const prev = snap({ humanWord: "loop", loopStatus: LOOP_STATUS.IDLE, stateTag: "[idle]" });
    const next = snap({ humanWord: "stop", loopStatus: LOOP_STATUS.BUSY, stateTag: "[busy]" });
    assert.deepEqual(
        diffSnapshots(prev, next).sort(),
        ["humanWord", "loopStatus", "stateTag"].sort(),
    );
});

test("computeBarSnapshot: cold boot (ipc vide) → status=boot", () => {
    const sd = mkSd();
    const s = computeBarSnapshot(sd);
    assert.equal(s.loopStatus, LOOP_STATUS.BOOT);
    assert.equal(s.stateTag, "[boot]");
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

test("BarRenderer.start: initial tick + subscribe ; stop: unsubscribe propre", () => {
    const sd = mkSd();
    const r = new BarRenderer(sd, "cl-test");
    r.start();
    // Initial tick a tourné — vérifie qu'on n'a pas planté.
    r.stop();
    // start/stop répétés doivent être idempotents (pas de leak setTimeout).
    r.start();
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

test("BarRenderer.tick: idempotent quand l'état ne change pas", () => {
    const sd = mkSd();
    const r = new BarRenderer(sd, "cl-test");
    r.tick(); // initial — log tout
    r.tick(); // 2e — no-op (rien changé)
    r.stop();
    rmSync(sd, { recursive: true, force: true });
});

// #862 Slice 2 — setIpcCounters + counters/zen/afkChipStr champs.

test("setIpcCounters: stocke un object normalisé dans ipcState", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 3, backlog: 2, events: 0 });
    assert.deepEqual(getIpcState().counters, { open: 3, backlog: 2, events: 0 });
});

test("setIpcCounters: champs absents → normalisés à null", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 5 });
    assert.deepEqual(getIpcState().counters, { open: 5, backlog: null, events: null });
});

test("setIpcCounters(null): clear le segment", () => {
    resetIpcStateForTests();
    setIpcCounters({ open: 3 });
    setIpcCounters(null);
    assert.equal(getIpcState().counters, null);
});

test("computeBarSnapshot: lit ipc.counters", () => {
    const sd = mkSd();
    setIpcCounters({ open: 4, backlog: 1, events: 2 });
    const s = computeBarSnapshot(sd);
    assert.deepEqual(s.counters, { open: 4, backlog: 1, events: 2 });
    rmSync(sd, { recursive: true, force: true });
});

test("computeBarSnapshot: zen file présent → zenActive=true", () => {
    const sd = mkSd();
    writeFileSync(join(sd, "zen"), "");
    const s = computeBarSnapshot(sd);
    assert.equal(s.zenActive, true);
    rmSync(sd, { recursive: true, force: true });
});

test("diffSnapshots: counters diff via deep-equal (= changement réel)", () => {
    const prev = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    const next = snap({ counters: { open: 2, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), ["counters"]);
});

test("diffSnapshots: counters identiques (objects refs différentes) → no diff", () => {
    const prev = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    const next = snap({ counters: { open: 1, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), []);
});

test("diffSnapshots: counters null vs {0,0,0} → diff (sémantique distinguée)", () => {
    const prev = snap({ counters: null });
    const next = snap({ counters: { open: 0, backlog: 0, events: 0 } });
    assert.deepEqual(diffSnapshots(prev, next), ["counters"]);
});
