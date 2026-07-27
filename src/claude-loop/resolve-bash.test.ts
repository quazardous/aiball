/**
 * #1584 — resolving bash on Windows.
 *
 * The bug these pin is not subtle once seen: a bare `spawn("bash")` reaches
 * whichever bash.exe the PATH offers first, and on a Windows box with WSL that
 * is often the WSL launcher rather than Git Bash. What made it expensive was
 * the silence — the WSL child's output never reached the inherited fd, so the
 * loop died leaving a zero-byte log.
 *
 * `resolveBashCmd` is platform-dependent by nature, so these assert the
 * contract that holds on the RUNNING host, plus the parts that are pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveBashCmd, toShortPathWin } from "./resolve-bash.js";

test("never returns the WSL launcher", () => {
    const cmd = resolveBashCmd().toLowerCase();
    // The two shapes that make a loop die silently on Windows.
    assert.ok(!cmd.includes("system32"), `resolved to the WSL launcher: ${cmd}`);
    assert.ok(!cmd.includes("windowsapps"), `resolved to the Store WSL stub: ${cmd}`);
});

test("on win32 it resolves an absolute path that exists, not a PATH lookup", () => {
    if (process.platform !== "win32") return; // POSIX asserted below
    const cmd = resolveBashCmd();
    if (cmd === "bash") return; // no Git Bash on this box — documented fallback
    assert.ok(/^[a-z]:\\/i.test(cmd), `expected an absolute path, got ${cmd}`);
    assert.ok(existsSync(cmd), `resolved to a path that does not exist: ${cmd}`);
});

test("the resolved command carries no space, or psmux splits it", () => {
    // psmux rebuilds the CreateProcess command line by splitting at spaces, so
    // "C:\Program Files\..." would arrive as "C:\Program" + junk.
    assert.ok(!resolveBashCmd().includes(" "), "a resolved bash with a space breaks psmux");
});

test("off win32 it stays a plain PATH lookup", () => {
    if (process.platform === "win32") return;
    assert.equal(resolveBashCmd(), "bash");
});

test("toShortPathWin is a no-op off win32 and for space-less paths", () => {
    assert.equal(toShortPathWin("/usr/bin/bash"), "/usr/bin/bash");
    assert.equal(toShortPathWin("C:\\Git\\bin\\bash.exe"), "C:\\Git\\bin\\bash.exe");
});
