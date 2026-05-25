// #451 — file spool for operator→loop prompts. node:test, temp AIBALL_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spoolPrompt, drainPrompts, countSpooledPrompts } from "./loop-prompts.js";

function withHome(fn: () => void): void {
    const prev = process.env.AIBALL_HOME;
    const home = mkdtempSync(join(tmpdir(), "loopprompts-"));
    process.env.AIBALL_HOME = home;
    try { fn(); }
    finally {
        if (prev === undefined) delete process.env.AIBALL_HOME;
        else process.env.AIBALL_HOME = prev;
        rmSync(home, { recursive: true, force: true });
    }
}

test("spool → drain returns texts oldest-first, then empties", () => {
    withHome(() => {
        assert.deepEqual(drainPrompts("agent-x"), []);
        spoolPrompt("agent-x", "first");
        spoolPrompt("agent-x", "second");
        assert.equal(countSpooledPrompts("agent-x"), 2);
        assert.deepEqual(drainPrompts("agent-x"), ["first", "second"]);
        // drained == deleted → a second drain is empty.
        assert.deepEqual(drainPrompts("agent-x"), []);
        assert.equal(countSpooledPrompts("agent-x"), 0);
    });
});

test("spools are isolated per consumer", () => {
    withHome(() => {
        spoolPrompt("a", "for-a");
        spoolPrompt("b", "for-b");
        assert.deepEqual(drainPrompts("a"), ["for-a"]);
        assert.deepEqual(drainPrompts("b"), ["for-b"]);
    });
});

test("multi-line prompt text round-trips verbatim", () => {
    withHome(() => {
        const text = "line 1\nline 2\n  indented";
        spoolPrompt("agent-x", text);
        assert.deepEqual(drainPrompts("agent-x"), [text]);
    });
});

test("a consumer_id with fs-unsafe chars is sanitised (no crash, isolated)", () => {
    withHome(() => {
        spoolPrompt("weird/../id", "x");
        assert.equal(countSpooledPrompts("weird/../id"), 1);
        assert.deepEqual(drainPrompts("weird/../id"), ["x"]);
    });
});
