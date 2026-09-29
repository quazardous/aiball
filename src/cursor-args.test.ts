/**
 * The cursor position reader — the command and its parse.
 *
 * The bug pinned here: the kernel had its own copy of the reader, which drifted
 * to `display-message -F "#{cursor_x} #{cursor_y}"`. psmux does not know
 * `-F` for this command and treats it as a word of the message: it answers
 * `-F 2,36` with `exit 0`, which the parse rejects. Measured result on
 * Windows: `captureCursor()` returned `null` on EVERY poll, with no error, no
 * trace — and the cursor rule (the one that tells a greyed-out suggestion
 * from real typing) never ran.
 *
 * So we test the argv, not just the parse: it was the shape of the
 * command that was wrong, and a correct parse of an input we never
 * receive proves nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorArgs, parseCursor } from "./pane.js";

test("the format goes as a POSITIONAL ARGUMENT, never after -F", () => {
    const args = cursorArgs("sess.0");
    assert.equal(args.includes("-F"), false, "psmux would take -F for a word of the message");
    assert.equal(args.at(-1), "#{cursor_x},#{cursor_y}", "the format must be the last argument");
});

test("the argv targets the requested pane", () => {
    const args = cursorArgs("cl-projet-42.0");
    assert.deepEqual(args.slice(0, 4), ["display-message", "-p", "-t", "cl-projet-42.0"]);
});

test("parses the normal answer, whatever the line ending", () => {
    assert.deepEqual(parseCursor("2,36"), { x: 2, y: 36 });
    assert.deepEqual(parseCursor("2,36\n"), { x: 2, y: 36 });
    assert.deepEqual(parseCursor("  0,0  \r\n"), { x: 0, y: 0 });
});

test("rejects the answer the -F form produced", () => {
    // REAL output measured on psmux with the old command.
    assert.equal(parseCursor("-F 2 36"), null);
});

test("rejects noise rather than inventing a position", () => {
    for (const junk of ["", "no current target", "2", "x,y", "2,36,7"]) {
        assert.equal(parseCursor(junk), null, `input ${JSON.stringify(junk)}`);
    }
});
