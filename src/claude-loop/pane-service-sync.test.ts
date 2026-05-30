// #647 Slice 3 — syncPaneServiceFromMarkers : mirrors marker files
// into the typed PaneService singleton. Pinned : (a) every file existing
// → its marker active ; (b) every file missing → its marker inactive ;
// (c) screen-takeover mutex respects only-one-active priority order ;
// (d) error group mirrors the errId param (undefined = unchanged) ;
// (e) flips notify subscribers exactly once per transition.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aiball-647s3-"));

const {
    setPaneBusy,
    setPaneReady,
    setCompacting,
    setResumeSessionPicker,
    setResumeModePicker,
    clearResumePickers,
} = await import("./state.js");
const {
    PaneMarker,
    ERROR_GROUP,
    SCREEN_TAKEOVER_GROUP,
    getPaneService,
    resetPaneServiceForTests,
} = await import("./pane-service.js");
const { syncPaneServiceFromMarkers } = await import("./pane-service-sync.js");

function clearAll(): void {
    setPaneBusy(dir, false);
    setPaneReady(dir, false);
    setCompacting(dir, false);
    clearResumePickers(dir);
}

beforeEach(() => {
    resetPaneServiceForTests();
    clearAll();
});

test("sync : empty state-dir → every PaneMarker inactive", () => {
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    for (const m of Object.values(PaneMarker)) {
        assert.equal(svc.get(m), false, `${m} should be inactive`);
    }
});

test("sync : paneBusy file → PaneMarker.Busy active", () => {
    setPaneBusy(dir, true);
    syncPaneServiceFromMarkers(dir);
    assert.equal(getPaneService().get(PaneMarker.Busy), true);
});

test("sync : paneReady file → Ready AND PaneReady active (paired today)", () => {
    setPaneReady(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.Ready), true);
    assert.equal(svc.get(PaneMarker.PaneReady), true);
});

test("sync : Compacting file → PaneMarker.Compacting (screen-takeover)", () => {
    setCompacting(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.Compacting), true);
    assert.equal(svc.get(PaneMarker.ResumeSessionPicker), false);
});

test("sync : ResumeSessionPicker file → matching marker (screen-takeover)", () => {
    setResumeSessionPicker(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.ResumeSessionPicker), true);
    assert.equal(svc.get(PaneMarker.ResumeModePicker), false);
    assert.equal(svc.get(PaneMarker.Compacting), false);
});

test("sync : ResumeModePicker file → matching marker (screen-takeover)", () => {
    setResumeModePicker(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.ResumeModePicker), true);
    assert.equal(svc.get(PaneMarker.ResumeSessionPicker), false);
});

test("sync : screen-takeover priority — session > mode > compacting", () => {
    // All three "present" simultaneously (defensive — emitter promises
    // only one but we tolerate the race). Sync picks the highest-
    // priority and clears the rest in the service.
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    setCompacting(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.ResumeSessionPicker), true);
    assert.equal(svc.get(PaneMarker.ResumeModePicker), false);
    assert.equal(svc.get(PaneMarker.Compacting), false);
});

test("sync : errId='rate-limit' → ErrorRateLimit, clears others", () => {
    syncPaneServiceFromMarkers(dir, { errId: "rate-limit" });
    const svc = getPaneService();
    assert.equal(svc.get(PaneMarker.ErrorRateLimit), true);
    assert.equal(svc.get(PaneMarker.ErrorApiError), false);
});

test("sync : errId=null clears every error marker", () => {
    syncPaneServiceFromMarkers(dir, { errId: "api-error" });
    assert.equal(getPaneService().get(PaneMarker.ErrorApiError), true);
    syncPaneServiceFromMarkers(dir, { errId: null });
    for (const m of ERROR_GROUP) {
        assert.equal(getPaneService().get(m), false);
    }
});

test("sync : errId omitted → error markers unchanged (idempotent on group)", () => {
    syncPaneServiceFromMarkers(dir, { errId: "overloaded" });
    syncPaneServiceFromMarkers(dir); // no errId → don't touch
    assert.equal(getPaneService().get(PaneMarker.ErrorOverloaded), true);
});

test("sync : flips fire subscribers exactly once per transition", () => {
    const svc = getPaneService();
    let busyEvents = 0;
    svc.subscribe(PaneMarker.Busy, () => { busyEvents++; });
    setPaneBusy(dir, true);
    syncPaneServiceFromMarkers(dir);
    syncPaneServiceFromMarkers(dir); // no change → no notification
    setPaneBusy(dir, false);
    syncPaneServiceFromMarkers(dir);
    assert.equal(busyEvents, 2, "one event for true, one for false");
});

test("sync : screen-takeover transition fires both markers (off old, on new)", () => {
    setResumeSessionPicker(dir, true);
    syncPaneServiceFromMarkers(dir);
    const svc = getPaneService();
    const events: Array<[boolean, string]> = [];
    svc.subscribeAny((active, m) => {
        if (SCREEN_TAKEOVER_GROUP.includes(m)) events.push([active, m]);
    });
    setResumeSessionPicker(dir, false);
    setResumeModePicker(dir, true);
    syncPaneServiceFromMarkers(dir);
    // Order : session=false (cleared by setExclusive), then mode=true.
    assert.deepEqual(events, [
        [false, PaneMarker.ResumeSessionPicker],
        [true, PaneMarker.ResumeModePicker],
    ]);
});

after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});
