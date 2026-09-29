/**
 * #3299 — a board launcher may be a .cmd or .bat. Windows refuses to spawn one
 * without a shell (EINVAL, thrown synchronously), so it goes through cmd.exe
 * with each argument quoted; anything else, and every other platform, is
 * spawned as it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchArgv } from "./launch-argv.js";

test("a .cmd / .bat launcher runs through cmd.exe on Windows, arguments quoted", () => {
    const a = launchArgv("C:\tools\my app\go.cmd", ["hello world", "x&y", "plain", ""], "win32");
    assert.equal(a.verbatim, true);
    assert.deepEqual(a.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(a.args[3], '""C:\tools\my app\go.cmd" "hello world" "x&y" plain """');
    assert.equal(launchArgv("C:\t\GO.BAT", [], "win32").verbatim, true, "the extension is matched in any case");
});

test("anything else is spawned as it is", () => {
    assert.deepEqual(launchArgv("C:\tools\app.exe", ["a b"], "win32"), { cmd: "C:\tools\app.exe", args: ["a b"], verbatim: false });
    assert.deepEqual(launchArgv("/usr/local/bin/go.cmd", ["x"], "linux"), { cmd: "/usr/local/bin/go.cmd", args: ["x"], verbatim: false });
});
