/**
 * #2413 david — a loop renders every wake from a COPY of its template taken at
 * start, and no reload refreshed it: a decided wording reached no loop until a
 * full restart. What must hold:
 * - a copy that lags its source is refreshed, byte for byte;
 * - a copy already identical is left alone;
 * - a loop started with a custom template keeps ITS template (the source is
 *   whatever was copied, not the shipped default);
 * - an older plate that never recorded a source is not guessed at: it says so;
 * - `list` / `check` say when a loop's template lags, and say nothing otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pingsPath, pingsSnapshotNote, refreshPingsSnapshot } from "./state.js";

function stateDir(): string {
    return mkdtempSync(join(tmpdir(), "cl-2413-"));
}

test("a copy that lags its source is refreshed, and then says nothing more", () => {
    const sd = stateDir();
    const src = join(sd, "..", `shipped-${Date.now()}.yaml`);
    writeFileSync(src, "wake_master: new wording\n");
    writeFileSync(pingsPath(sd), "wake_master: old wording\n");
    try {
        assert.match(pingsSnapshotNote(sd, { pings_src: src }) ?? "", /changed since boot — reload/);
        assert.equal(refreshPingsSnapshot(sd, { pings_src: src }), "refreshed");
        assert.equal(readFileSync(pingsPath(sd), "utf8"), "wake_master: new wording\n");
        assert.equal(refreshPingsSnapshot(sd, { pings_src: src }), "unchanged", "a second reload has nothing to do");
        assert.equal(pingsSnapshotNote(sd, { pings_src: src }), null, "a current template is not mentioned");
    } finally {
        rmSync(sd, { recursive: true, force: true });
        rmSync(src, { force: true });
    }
});

test("a loop started with its own template keeps its own, refreshed from it", () => {
    const sd = stateDir();
    const custom = join(sd, "..", `custom-${Date.now()}.yaml`);
    writeFileSync(custom, "wake_master: my team's own wording, edited\n");
    writeFileSync(pingsPath(sd), "wake_master: my team's own wording\n");
    try {
        assert.equal(refreshPingsSnapshot(sd, { pings_src: custom }), "refreshed");
        assert.equal(readFileSync(pingsPath(sd), "utf8"), "wake_master: my team's own wording, edited\n", "never swapped for the shipped default");
    } finally {
        rmSync(sd, { recursive: true, force: true });
        rmSync(custom, { force: true });
    }
});

test("an older plate with no recorded source is not guessed at — it says to restart", () => {
    const sd = stateDir();
    writeFileSync(pingsPath(sd), "wake_master: whatever it started with\n");
    try {
        assert.equal(refreshPingsSnapshot(sd, {}), "no-source");
        assert.equal(readFileSync(pingsPath(sd), "utf8"), "wake_master: whatever it started with\n", "left untouched");
        assert.match(pingsSnapshotNote(sd, {}) ?? "", /frozen at start .* restart/);
    } finally {
        rmSync(sd, { recursive: true, force: true });
    }
});

test("a recorded source that disappeared keeps the copy rather than breaking the loop", () => {
    const sd = stateDir();
    writeFileSync(pingsPath(sd), "wake_master: kept\n");
    try {
        assert.equal(refreshPingsSnapshot(sd, { pings_src: join(sd, "gone.yaml") }), "missing-source");
        assert.equal(readFileSync(pingsPath(sd), "utf8"), "wake_master: kept\n");
    } finally {
        rmSync(sd, { recursive: true, force: true });
    }
});
