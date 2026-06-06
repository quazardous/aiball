// #845 Phase A — PaneObserver dispatch + zone activation tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PaneObserver } from "./observer.js";
import { Zone } from "./zone.js";
import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./types.js";

// Bare-bones counting watcher to assert dispatch shape without dragging
// the real watchers in. State = number of observe() calls.
class CountingWatcher implements PaneWatcher<{ ticks: number }> {
    constructor(readonly name: string) {}
    private state = { ticks: 0 };
    private throws = false;
    setThrowing(): void { this.throws = true; }
    observe(_paneText: string, _ctx: PaneScanCtx): { ticks: number } {
        if (this.throws) throw new Error("watcher boom");
        this.state = { ticks: this.state.ticks + 1 };
        return this.state;
    }
    snapshot(): { ticks: number } { return this.state; }
    on<E extends keyof PaneWatcherEvents<{ ticks: number }>>(
        _e: E, _cb: NonNullable<PaneWatcherEvents<{ ticks: number }>[E]>,
    ): () => void { return () => {}; }
    reset(): void { this.state = { ticks: 0 }; }
}

const CTX: PaneScanCtx = { nowMs: 1_000 };

test("PaneObserver: zone not entered → tick is a no-op", () => {
    const obs = new PaneObserver();
    const w = new CountingWatcher("w1");
    obs.registerZone(new Zone("Z", [w]));
    obs.tick("", CTX);
    assert.equal(w.snapshot().ticks, 0);
});

test("PaneObserver: enter then tick dispatches once", () => {
    const obs = new PaneObserver();
    const w = new CountingWatcher("w1");
    obs.registerZone(new Zone("Z", [w]));
    obs.enter("Z");
    obs.tick("", CTX);
    assert.equal(w.snapshot().ticks, 1);
});

test("PaneObserver: leave stops dispatch", () => {
    const obs = new PaneObserver();
    const w = new CountingWatcher("w1");
    obs.registerZone(new Zone("Z", [w]));
    obs.enter("Z");
    obs.tick("", CTX);
    obs.leave("Z");
    obs.tick("", CTX);
    assert.equal(w.snapshot().ticks, 1);
});

test("PaneObserver: watcher in two active zones runs ONCE per tick (dedup)", () => {
    const obs = new PaneObserver();
    const w = new CountingWatcher("shared");
    obs.registerZone(new Zone("Z1", [w]));
    obs.registerZone(new Zone("Z2", [w]));
    obs.enter("Z1");
    obs.enter("Z2");
    obs.tick("", CTX);
    assert.equal(w.snapshot().ticks, 1);
});

test("PaneObserver: distinct watchers in distinct active zones both run", () => {
    const obs = new PaneObserver();
    const wA = new CountingWatcher("a");
    const wB = new CountingWatcher("b");
    obs.registerZone(new Zone("Z1", [wA]));
    obs.registerZone(new Zone("Z2", [wB]));
    obs.enter("Z1");
    obs.enter("Z2");
    obs.tick("", CTX);
    assert.equal(wA.snapshot().ticks, 1);
    assert.equal(wB.snapshot().ticks, 1);
});

test("PaneObserver: watcher throw isolates — other watchers still run", () => {
    const obs = new PaneObserver();
    const boom = new CountingWatcher("boom");
    boom.setThrowing();
    const ok = new CountingWatcher("ok");
    obs.registerZone(new Zone("Z", [boom, ok]));
    obs.enter("Z");
    obs.tick("", CTX);
    assert.equal(ok.snapshot().ticks, 1);
});

test("PaneObserver: enter unknown zone is silent + tick skips it", () => {
    const obs = new PaneObserver();
    obs.enter("ghost");          // never registered
    obs.tick("", CTX);           // no throw
    assert.equal(obs.isActive("ghost"), true);
});

test("PaneObserver: transition swaps active zones atomically", () => {
    const obs = new PaneObserver();
    const boot = new CountingWatcher("boot");
    const runtime = new CountingWatcher("runtime");
    obs.registerZone(new Zone("boot", [boot]));
    obs.registerZone(new Zone("runtime", [runtime]));
    obs.enter("boot");
    obs.tick("", CTX);
    obs.transition(["boot"], ["runtime"]);
    obs.tick("", CTX);
    assert.equal(boot.snapshot().ticks, 1);
    assert.equal(runtime.snapshot().ticks, 1);
});

test("PaneObserver: registerZone replaces a previously-registered zone of the same name", () => {
    const obs = new PaneObserver();
    const wOld = new CountingWatcher("old");
    const wNew = new CountingWatcher("new");
    obs.registerZone(new Zone("Z", [wOld]));
    obs.registerZone(new Zone("Z", [wNew]));   // replaces
    obs.enter("Z");
    obs.tick("", CTX);
    assert.equal(wOld.snapshot().ticks, 0);
    assert.equal(wNew.snapshot().ticks, 1);
});
