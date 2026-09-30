/**
 * #3416 — on Windows a bare `tmux` is psmux's alias, several times slower to
 * start than `psmux.exe`: the loop drives psmux directly when it is there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { onWindowsPath, resolveMuxCmd } from "./mux-cmd.js";

const yes = () => true;
const no = () => false;

test("Windows: a bare tmux — the default, or an old loop's env — means psmux when it is installed", () => {
    assert.equal(resolveMuxCmd(undefined, "win32", yes), "psmux");
    assert.equal(resolveMuxCmd("", "win32", yes), "psmux");
    assert.equal(resolveMuxCmd("tmux", "win32", yes), "psmux");
});

test("Windows: without psmux, or with anything else asked for, the command is left alone", () => {
    assert.equal(resolveMuxCmd(undefined, "win32", no), "tmux");
    assert.equal(resolveMuxCmd("psmux", "win32", no), "psmux");
    assert.equal(resolveMuxCmd("C:\\tools\\tmux.exe", "win32", yes), "C:\\tools\\tmux.exe", "a path is a choice");
});

test("elsewhere tmux is tmux, whatever is installed", () => {
    for (const platform of ["linux", "darwin"] as const) {
        assert.equal(resolveMuxCmd(undefined, platform, yes), "tmux");
        assert.equal(resolveMuxCmd("tmux", platform, yes), "tmux");
        assert.equal(resolveMuxCmd("mux-x", platform, yes), "mux-x");
    }
});

test("psmux is looked for as psmux.exe in the PATH's folders, without starting anything", () => {
    const dirs = ["C:\\a", "C:\\b"];
    const seen: string[] = [];
    const exists = (p: string) => { seen.push(p); return p === join("C:\\b", "psmux.exe"); };
    assert.equal(onWindowsPath("psmux", dirs.join(delimiter), exists), true);
    assert.deepEqual(seen, [join("C:\\a", "psmux.exe"), join("C:\\b", "psmux.exe")]);
    assert.equal(onWindowsPath("psmux", "", exists), false);
    assert.equal(onWindowsPath("psmux", undefined, () => false), false);
});
