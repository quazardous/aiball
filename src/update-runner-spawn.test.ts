/**
 * #1586 — how `aiball update` starts its Windows runner. Started detached as a
 * bare `powershell.exe -File …`, Windows PowerShell exited at once without
 * running the script: the update said "started in the background" and nothing
 * ran. The runner must run, after the process that started it has exited.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { windowsRunnerSpawn } from "./update-run.js";

const root = mkdtempSync(join(tmpdir(), "aiball-1586-runner-"));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("the runner is started through cmd's start, hidden, its path kept as one argument", () => {
    const s = windowsRunnerSpawn("C:\\Users\\John Doe\\AppData\\Local\\Temp\\aiball-update-1.ps1");
    assert.equal(s.exe, "cmd.exe");
    assert.deepEqual(s.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(s.args[3], `"start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\John Doe\\AppData\\Local\\Temp\\aiball-update-1.ps1""`);
    assert.equal(s.options.detached, true);
    assert.equal(s.options.cwd, "C:\\Users\\John Doe\\AppData\\Local\\Temp", "the runner's folder, not the install dir this process runs from");
    assert.equal(s.options.windowsVerbatimArguments, true, "or Node re-quotes the command line and cmd.exe misreads it");
});

test("on Windows: the runner runs, after the process that started it has exited", { skip: process.platform !== "win32" }, () => {
    // A folder with a space in its name: a user profile often has one.
    const dir = join(root, "with space");
    mkdirSync(dir);
    const marker = join(dir, "ran.txt");
    const runner = join(dir, "runner.ps1");
    writeFileSync(runner, `Start-Sleep -Milliseconds 1500\r\nSet-Content -LiteralPath '${marker}' -Value 'ran'\r\n`);
    // The install dir the command runs from: the update must be able to move it.
    const install = join(root, "install");
    mkdirSync(install);
    // A parent that starts the runner and exits at once, as `aiball update` does.
    const parent = spawnSync(process.execPath, [
        "-e",
        "const s = JSON.parse(process.argv[1]); require('node:child_process').spawn(s.exe, s.args, s.options).unref(); process.exit(0);",
        JSON.stringify(windowsRunnerSpawn(runner)),
    ], { encoding: "utf8", cwd: install });
    assert.equal(parent.status, 0, parent.stderr);
    assert.equal(existsSync(marker), false, "the runner is still sleeping: the parent did exit before it finished");
    // While the runner runs, the folder the command was in can be moved: the runner did not keep it.
    renameSync(install, join(root, "install.previous"));
    for (let i = 0; i < 100 && !existsSync(marker); i++) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
    assert.ok(existsSync(marker), "the runner never ran");
    assert.match(readFileSync(marker, "utf8"), /ran/);
});
