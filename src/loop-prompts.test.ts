// #451 — volatile in-memory spool for operator→loop prompts. node:test.
// The spool is a process-global Map → each test uses its own consumer id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spoolPrompt, drainPrompts, countSpooledPrompts } from "./loop-prompts.js";

test("spool → drain returns texts FIFO, then empties", () => {
    assert.deepEqual(drainPrompts("t1-x"), []);
    spoolPrompt("t1-x", "first");
    spoolPrompt("t1-x", "second");
    assert.equal(countSpooledPrompts("t1-x"), 2);
    assert.deepEqual(drainPrompts("t1-x"), ["first", "second"]);
    // drained == removed → a second drain is empty.
    assert.deepEqual(drainPrompts("t1-x"), []);
    assert.equal(countSpooledPrompts("t1-x"), 0);
});

test("spools are isolated per consumer", () => {
    spoolPrompt("t2-a", "for-a");
    spoolPrompt("t2-b", "for-b");
    assert.deepEqual(drainPrompts("t2-a"), ["for-a"]);
    assert.deepEqual(drainPrompts("t2-b"), ["for-b"]);
});

test("multi-line prompt text round-trips verbatim", () => {
    const text = "line 1\nline 2\n  indented";
    spoolPrompt("t3-x", text);
    assert.deepEqual(drainPrompts("t3-x"), [text]);
});

test("count reflects the queue without draining", () => {
    spoolPrompt("t4-x", "a");
    spoolPrompt("t4-x", "b");
    assert.equal(countSpooledPrompts("t4-x"), 2);
    assert.equal(countSpooledPrompts("t4-x"), 2); // non-destructive
    drainPrompts("t4-x");
});
