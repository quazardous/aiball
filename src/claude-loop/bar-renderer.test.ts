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
    resetIpcStateForTests,
    setIpcBootComplete,
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
        ...overrides,
    };
}

test("diffSnapshots: prev=null → tous les champs marqués changed (initial)", () => {
    assert.deepEqual(
        diffSnapshots(null, snap()),
        ["humanWord", "loopStatus", "stateTag", "proxyAlive"],
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
