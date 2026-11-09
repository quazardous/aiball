/**
 * #4867 — what a node answers while cut from its master: the reads it lists are
 * real methods, and none of them is one that writes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4867-cut-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { getMethod } = await import("./bus/methods.js");
await import("./bus/register.js");
const { CUT_READS } = await import("./replica-node.js");

test("each read a cut node answers is a method of the bus", () => {
    assert.deepEqual([...CUT_READS].filter((m) => !getMethod(m)), []);
});

test("none of them is a write", () => {
    const writes = /\\.(post|set_|mark|decide|delete|create|update|assign|subscribe$|unsubscribe$|vote|edit)/;
    assert.deepEqual([...CUT_READS].filter((m) => !m.startsWith("bus.") && writes.test(m)), []);
});
