// #1032 S1 — per-component offload buffer : append on broken comm (with the
// original ts), drain-and-clear on reconnect (ts preserved for a unified
// timeline). Best-effort : never throws.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOffload, drainOffload, offloadPath } from "./offload.js";

const SD = mkdtempSync(join(tmpdir(), "aiball-offload-"));
after(() => rmSync(SD, { recursive: true, force: true }));

test("#1032 append then drain returns entries in order and clears the buffer", () => {
    appendOffload(SD, "proxy", { kind: "keypress", msg: "F9", ts: "2026-01-01T00:00:01.000Z" });
    appendOffload(SD, "proxy", { kind: "keypress", msg: "F9", ts: "2026-01-01T00:00:02.000Z" });

    const drained = drainOffload(SD, "proxy");
    assert.equal(drained.length, 2);
    assert.deepEqual(drained.map((e) => e.ts), [
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
    ]);
    assert.equal(drained[0].component, "proxy");
    assert.equal(drained[0].kind, "keypress");
    assert.equal(drained[0].msg, "F9");

    // Buffer is cleared after drain.
    assert.equal(readFileSync(offloadPath(SD, "proxy"), "utf8"), "");
    assert.deepEqual(drainOffload(SD, "proxy"), []);
});

test("#1032 ts is preserved when supplied, stamped when omitted", () => {
    appendOffload(SD, "timer", { kind: "marker", ts: "2025-12-31T23:59:59.000Z" });
    appendOffload(SD, "timer", { kind: "marker" }); // no ts → stamped now
    const drained = drainOffload(SD, "timer");
    assert.equal(drained.length, 2);
    assert.equal(drained[0].ts, "2025-12-31T23:59:59.000Z", "explicit ts preserved");
    assert.match(drained[1].ts, /^\d{4}-\d{2}-\d{2}T/, "omitted ts stamped ISO");
});

test("#1032 buffers are per-component (separate files)", () => {
    appendOffload(SD, "bar", { kind: "repaint" });
    appendOffload(SD, "proxy", { kind: "keypress" });
    const bar = drainOffload(SD, "bar");
    const proxy = drainOffload(SD, "proxy");
    assert.equal(bar.length, 1);
    assert.equal(bar[0].kind, "repaint");
    assert.equal(proxy.length, 1);
    assert.equal(proxy[0].kind, "keypress");
});

test("#1032 drain of an absent buffer is [] (no throw)", () => {
    assert.deepEqual(drainOffload(SD, "never-written"), []);
});

test("#1032 append never throws even on an unwritable state dir", () => {
    // A bogus path under a file (not a dir) → mkdir/append fail internally,
    // swallowed. The point: the fallback must not cascade.
    assert.doesNotThrow(() => appendOffload("/dev/null/nope", "x", { kind: "k" }));
});
