/**
 * #1740 — the pane geometry reader, which lets a consumer render the WHOLE
 * pane scaled down instead of cropping it to its own container.
 *
 * Two things are worth pinning here. The argv shape must stay POSITIONAL for
 * the same reason `cursor-args.test.ts` pins the cursor one: psmux (Windows)
 * does not know `-F` and treats it as a word of the message, answering with
 * `exit 0` and an unparseable line. And the parse must reject zero, because
 * the consumer divides by these values to compute its scale.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { geometryArgs, parseGeometry } from "./pane.js";

test("geometryArgs: the format is the last argument, positional (no -F)", () => {
    const args = geometryArgs("cl-projet-42.0");
    assert.equal(args.at(-1), "#{pane_width},#{pane_height}");
    assert.ok(!args.includes("-F"), "-F would be echoed back as text by psmux");
    assert.deepEqual(args.slice(0, 4), ["display-message", "-p", "-t", "cl-projet-42.0"]);
});

test("parseGeometry: reads columns and rows", () => {
    assert.deepEqual(parseGeometry("204,52"), { cols: 204, rows: 52 });
    assert.deepEqual(parseGeometry("  80,24\n"), { cols: 80, rows: 24 });
});

test("parseGeometry: rejects zero — the consumer divides by these", () => {
    assert.equal(parseGeometry("0,24"), null);
    assert.equal(parseGeometry("80,0"), null);
});

test("parseGeometry: rejects what psmux answers when it does not know the format", () => {
    // The exact shape of the -F trap: a successful command that returns the
    // flag itself as part of the message.
    assert.equal(parseGeometry("-F 204,52"), null);
    assert.equal(parseGeometry(""), null);
    assert.equal(parseGeometry("#{pane_width},#{pane_height}"), null);
});
