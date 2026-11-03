/** #4698 — what a loop keeps of its Claude ending. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepPreviousLog, screenTail, takePreviousLog } from "./exit-trace.js";

const dir = mkdtempSync(join(tmpdir(), "aiball-4698-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the screen's last lines, blank ones at the bottom dropped", () => {
    const screen = ["a", "b", "c", "", "  ", ""].join("\n");
    assert.equal(screenTail(screen), "a\nb\nc");
    assert.equal(screenTail(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"), 3), "l37\nl38\nl39");
    assert.equal(screenTail(""), "");
});

test("the previous loop's log survives the state dir being cleared, as loop.log.prev", () => {
    const sd = join(dir, "cl-x");
    mkdirSync(sd);
    writeFileSync(join(sd, "loop.log"), "the old loop's last line\n");
    const kept = takePreviousLog(sd);
    rmSync(sd, { recursive: true, force: true });
    mkdirSync(sd);
    keepPreviousLog(sd, kept);
    assert.equal(readFileSync(join(sd, "loop.log.prev"), "utf8"), "the old loop's last line\n");
});

test("no previous log: nothing written, nothing thrown", () => {
    const sd = join(dir, "cl-y");
    mkdirSync(sd);
    assert.equal(takePreviousLog(sd), null);
    keepPreviousLog(sd, null);
    assert.equal(existsSync(join(sd, "loop.log.prev")), false);
});
