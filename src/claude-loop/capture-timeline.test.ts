// #990 — CL_CAPTURE=1 unified capture. `logPaneCapture` dumps each distinct
// pane frame as `capture/panes/<ms>.txt` and appends a small timeline row to
// `capture/panes.ndjson` that REFERENCES the file by short path (not inlined),
// with consecutive dedup. Env flag is read at module-load, so set it before
// the dynamic import (node:test gives this file its own process).
process.env.CL_CAPTURE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { logPaneCapture, captureDir, paneTimelinePath, capturePanesDir } = await import("./state.js");

test("CL_CAPTURE: pane frames → panes/<ms>.txt + referencing rows in panes.ndjson", () => {
    const sd = mkdtempSync(join(tmpdir(), "capture-990-"));

    logPaneCapture(sd, "frame A");
    logPaneCapture(sd, "frame A"); // consecutive dup → skipped
    logPaneCapture(sd, "frame B");

    const lines = readFileSync(paneTimelinePath(sd), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "dedup: only 2 distinct frames recorded");

    const rows = lines.map((l) => JSON.parse(l));
    for (const r of rows) {
        assert.equal(r.kind, "pane");
        assert.equal(typeof r.t, "number");
        // references a short path, does NOT inline the pane text
        assert.match(r.file, /^panes\//);
        assert.equal(r.text, undefined);
        // the referenced file exists under the capture dir
        assert.ok(existsSync(join(captureDir(sd), r.file)), `${r.file} should exist`);
    }
    assert.equal(readFileSync(join(captureDir(sd), rows[0].file), "utf8"), "frame A");
    assert.equal(readFileSync(join(captureDir(sd), rows[1].file), "utf8"), "frame B");

    // the dumped frames live in capture/panes/
    const dumped = readdirSync(capturePanesDir(sd)).filter((f) => f.endsWith(".txt"));
    assert.equal(dumped.length, 2);

    rmSync(sd, { recursive: true, force: true });
});
