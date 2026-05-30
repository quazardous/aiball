// #647 Slice 1 — PaneService unit tests. Greenfield, no fs/process side
// effects (the service is pure data). Run: `npx tsx --test src/claude-loop/pane-service.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PaneService, PaneMarker, SCREEN_TAKEOVER_GROUP, ERROR_GROUP, paneMarkerBarInfo } from "./pane-service.js";

test("get returns false for unset markers", () => {
    const svc = new PaneService();
    assert.equal(svc.get(PaneMarker.Busy), false);
    assert.equal(svc.get(PaneMarker.Compacting), false);
});

test("set toggles state, get reflects it", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.Busy, true);
    assert.equal(svc.get(PaneMarker.Busy), true);
    svc.set(PaneMarker.Busy, false);
    assert.equal(svc.get(PaneMarker.Busy), false);
});

test("set is idempotent — same value twice is a silent no-op", () => {
    const svc = new PaneService();
    let calls = 0;
    svc.subscribe(PaneMarker.Busy, () => { calls++; });
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Busy, true);  // no-op
    svc.set(PaneMarker.Busy, false);
    svc.set(PaneMarker.Busy, false); // no-op
    assert.equal(calls, 2, "only transitions notify");
});

test("subscribe receives (active, marker) on transitions", () => {
    const svc = new PaneService();
    const events: Array<[boolean, PaneMarker]> = [];
    svc.subscribe(PaneMarker.Ready, (active, m) => { events.push([active, m]); });
    svc.set(PaneMarker.Ready, true);
    svc.set(PaneMarker.Ready, false);
    assert.deepEqual(events, [
        [true, PaneMarker.Ready],
        [false, PaneMarker.Ready],
    ]);
});

test("subscribe targets one marker — other markers don't trigger", () => {
    const svc = new PaneService();
    let busyCalls = 0;
    svc.subscribe(PaneMarker.Busy, () => { busyCalls++; });
    svc.set(PaneMarker.Ready, true);  // should not fire
    svc.set(PaneMarker.Compacting, true);
    assert.equal(busyCalls, 0);
});

test("unsubscribe stops further calls", () => {
    const svc = new PaneService();
    let calls = 0;
    const off = svc.subscribe(PaneMarker.Busy, () => { calls++; });
    svc.set(PaneMarker.Busy, true);
    off();
    svc.set(PaneMarker.Busy, false);
    assert.equal(calls, 1);
});

test("subscribeAny fires on every marker change", () => {
    const svc = new PaneService();
    const events: PaneMarker[] = [];
    svc.subscribeAny((_active, m) => { events.push(m); });
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Compacting, true);
    svc.set(PaneMarker.Busy, false);
    assert.deepEqual(events, [PaneMarker.Busy, PaneMarker.Compacting, PaneMarker.Busy]);
});

test("snapshot returns a fresh Set of currently-active markers", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Compacting, true);
    const snap = svc.snapshot();
    assert.equal(snap.size, 2);
    assert.ok(snap.has(PaneMarker.Busy));
    assert.ok(snap.has(PaneMarker.Compacting));
    // Mutating the snapshot must not affect the service.
    snap.delete(PaneMarker.Busy);
    assert.equal(svc.get(PaneMarker.Busy), true);
});

test("setExclusive flips ONE member on, clears the rest of the group", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.ResumeSessionPicker, true);
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.ResumeModePicker);
    assert.equal(svc.get(PaneMarker.ResumeSessionPicker), false);
    assert.equal(svc.get(PaneMarker.ResumeModePicker), true);
    assert.equal(svc.get(PaneMarker.Compacting), false);
});

test("setExclusive(null) clears every member of the group", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.Compacting, true);
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, null);
    for (const m of SCREEN_TAKEOVER_GROUP) {
        assert.equal(svc.get(m), false);
    }
});

test("setExclusive does NOT touch markers outside the group", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Ready, true);
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.Compacting);
    assert.equal(svc.get(PaneMarker.Busy), true, "Busy preserved");
    assert.equal(svc.get(PaneMarker.Ready), true, "Ready preserved");
    assert.equal(svc.get(PaneMarker.Compacting), true);
});

test("setExclusive rejects a marker not in the group", () => {
    const svc = new PaneService();
    assert.throws(
        () => svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.ErrorApiError),
        /not a member of the given group/,
    );
});

test("setExclusive transition fires two events in order (off, then on)", () => {
    const svc = new PaneService();
    svc.set(PaneMarker.ResumeSessionPicker, true);
    const events: Array<[boolean, PaneMarker]> = [];
    svc.subscribeAny((active, m) => { events.push([active, m]); });
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.ResumeModePicker);
    assert.deepEqual(events, [
        [false, PaneMarker.ResumeSessionPicker],
        [true, PaneMarker.ResumeModePicker],
    ]);
});

test("ERROR_GROUP mutex works the same way", () => {
    const svc = new PaneService();
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorRateLimit);
    assert.equal(svc.get(PaneMarker.ErrorRateLimit), true);
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorOverloaded);
    assert.equal(svc.get(PaneMarker.ErrorRateLimit), false);
    assert.equal(svc.get(PaneMarker.ErrorOverloaded), true);
});

test("listener that throws does not break sibling listeners", () => {
    const svc = new PaneService();
    let okCalls = 0;
    svc.subscribe(PaneMarker.Busy, () => { throw new Error("boom"); });
    svc.subscribe(PaneMarker.Busy, () => { okCalls++; });
    svc.set(PaneMarker.Busy, true);
    assert.equal(okCalls, 1);
});

test("listener that unsubscribes itself during callback doesn't trip iteration", () => {
    const svc = new PaneService();
    let calls = 0;
    let off: (() => void) | undefined;
    off = svc.subscribe(PaneMarker.Busy, () => { calls++; off?.(); });
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Busy, false);
    assert.equal(calls, 1, "second transition should NOT call (we unsubscribed)");
});

// #647 Slice 4 — paneMarkerBarInfo : short label for tmux bar's [...:info].
test("paneMarkerBarInfo: null when only routine markers active", () => {
    const svc = new PaneService();
    assert.equal(paneMarkerBarInfo(svc), null);
    svc.set(PaneMarker.Busy, true);
    svc.set(PaneMarker.Ready, true);
    svc.set(PaneMarker.PaneReady, true);
    assert.equal(paneMarkerBarInfo(svc), null, "routine markers don't surface in info");
});

test("paneMarkerBarInfo: ResumeSessionPicker → 'picker:session'", () => {
    const svc = new PaneService();
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.ResumeSessionPicker);
    assert.equal(paneMarkerBarInfo(svc), "picker:session");
});

test("paneMarkerBarInfo: ResumeModePicker → 'picker:mode'", () => {
    const svc = new PaneService();
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.ResumeModePicker);
    assert.equal(paneMarkerBarInfo(svc), "picker:mode");
});

test("paneMarkerBarInfo: Compacting → 'compacting'", () => {
    const svc = new PaneService();
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.Compacting);
    assert.equal(paneMarkerBarInfo(svc), "compacting");
});

test("paneMarkerBarInfo: each error variant → 'err:<kind>'", () => {
    const svc = new PaneService();
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorRateLimit);
    assert.equal(paneMarkerBarInfo(svc), "err:rate-limit");
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorOverloaded);
    assert.equal(paneMarkerBarInfo(svc), "err:overloaded");
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorApiError);
    assert.equal(paneMarkerBarInfo(svc), "err:api");
});

test("paneMarkerBarInfo: screen-takeover wins over error if both somehow coexist", () => {
    const svc = new PaneService();
    svc.setExclusive(ERROR_GROUP, PaneMarker.ErrorRateLimit);
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, PaneMarker.Compacting);
    assert.equal(paneMarkerBarInfo(svc), "compacting");
});
