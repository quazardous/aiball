/**
 * #2588 — `aiball update` runs the update the way the machine was installed.
 * What must hold:
 * - no recorded install, or a dev checkout off main or with uncommitted
 *   changes, is refused with the reason and the command to run by hand;
 * - the steps that run are the command `aiball version` shows;
 * - on a real clone: pulled, installer run, output in the log, status `ok`;
 *   a failing step stops the run and the status names it;
 * - the Windows runner (run here under pwsh) does the same, then relaunches
 *   the tray whatever happened, and never restarts the daemon itself.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstallInfo, updateCommand, updateSteps } from "./install-info.js";
import { planUpdate, readGitState, readUpdateStatus, runUpdate, windowsRunnerScript } from "./update-run.js";

const DIR = mkdtempSync(join(tmpdir(), "aiball-2588-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const info = (o: object, platform: NodeJS.Platform = "linux") => parseInstallInfo(JSON.stringify(o), platform);
const clean = { branch: "main", dirty: false };

test("refused: no recorded install, a dev checkout off main, or with uncommitted changes", () => {
    const unknown = planUpdate(parseInstallInfo(null, "linux"), null);
    assert.equal(unknown.ok, false);
    assert.match(!unknown.ok ? unknown.reason : "", /re-run the installer once/);
    assert.equal(planUpdate(info({ mode: "sideways", source: "/c" }), clean).ok, false, "an unreadable mode is refused even with a source");

    const dev = info({ mode: "dev", source: "/src/aiball" });
    const off = planUpdate(dev, { branch: "feature/x", dirty: false });
    assert.match(!off.ok ? off.reason : "", /on feature\/x, not main — the update never switches its branch/);
    const detached = planUpdate(dev, { branch: null, dirty: false });
    assert.match(!detached.ok ? detached.reason : "", /detached HEAD/);
    const dirty = planUpdate(dev, { branch: "main", dirty: true });
    assert.match(!dirty.ok ? dirty.reason : "", /uncommitted changes/);
    assert.equal(dirty.command, updateCommand(dev), "a refusal still gives the command to run by hand");
    assert.equal(planUpdate(dev, null).ok, false);

    assert.equal(planUpdate(dev, clean).ok, true);
    assert.equal(planUpdate(info({ mode: "release", source: "/c" }), null).ok, true, "a release clone is not held to main");
});

test("what runs is what `aiball version` shows", () => {
    for (const [o, platform] of [
        [{ mode: "release", source: "/c", flags: ["--port", "7878"] }, "linux"],
        [{ mode: "edge", source: "/my clone" }, "linux"],
        [{ mode: "dev", source: "/s" }, "linux"],
        [{ mode: "edge", source: "C:\\a", flags: ["-Service"] }, "win32"],
    ] as const) {
        const i = info(o, platform);
        const plan = planUpdate(i, clean);
        assert.ok(plan.ok);
        assert.equal(plan.command, updateCommand(i));
        assert.deepEqual(plan.steps, updateSteps(i));
    }
    const devSteps = updateSteps(info({ mode: "dev", source: "/s" }))!;
    assert.deepEqual(devSteps.filter((s) => s.restart).map((s) => s.argv), [["aiball", "restart"]], "the restart is the last, flagged step");
    assert.equal(devSteps.at(-1)!.restart, true);
});

function sh(cwd: string, cmd: string): string {
    const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

/** An origin with one commit, a clone of it, then a second commit on the origin. */
function cloneBehind(name: string, installer: string, file: string): { origin: string; clone: string } {
    const origin = join(DIR, `${name}-origin`);
    const clone = join(DIR, `${name}-clone`);
    sh(DIR, `git init -q -b main ${origin} && cd ${origin} && git config user.email t@t && git config user.name t && printf '%s' '${installer.replace(/'/g, "'\\''")}' > ${file} && chmod +x ${file} && echo v1 > VERSION && git add -A && git commit -qm v1`);
    sh(DIR, `git clone -q ${origin} ${clone}`);
    sh(origin, "echo v2 > VERSION && git commit -qam v2");
    return { origin, clone };
}

test("git state: branch and tracked changes, an untracked file does not count", () => {
    const { clone } = cloneBehind("state", "#!/bin/sh\n", "install.sh");
    assert.deepEqual(readGitState(clone), { branch: "main", dirty: false });
    writeFileSync(join(clone, "scratch.txt"), "x");
    assert.deepEqual(readGitState(clone), { branch: "main", dirty: false });
    writeFileSync(join(clone, "VERSION"), "local edit");
    assert.equal(readGitState(clone)!.dirty, true);
    sh(clone, "git checkout -q -- VERSION && git checkout -q -b other");
    assert.equal(readGitState(clone)!.branch, "other");
    assert.equal(readGitState(DIR), null);
});

test("on a real clone: pulled, installer run with its flags, logged, status ok", async () => {
    const { clone } = cloneBehind("ok", "#!/bin/sh\necho \"installing with $*\"\necho \"$*\" > installed.txt\n", "install.sh");
    const plan = planUpdate(info({ mode: "release", source: clone, flags: ["--port", "7878"] }), null);
    assert.ok(plan.ok);
    const paths = { log: join(DIR, "ok", "update.log"), status: join(DIR, "ok", "update-status.json") };
    const status = await runUpdate(plan, paths);
    assert.equal(status.state, "ok", readFileSync(paths.log, "utf8"));
    assert.equal(readFileSync(join(clone, "VERSION"), "utf8").trim(), "v2", "the clone was pulled");
    assert.equal(readFileSync(join(clone, "installed.txt"), "utf8").trim(), "--port 7878");
    assert.match(readFileSync(paths.log, "utf8"), /\$ \.\/install\.sh --port 7878\ninstalling with --port 7878/);
    assert.deepEqual(readUpdateStatus(paths.status), status);
});

test("a failing step stops the run, and the status names it", async () => {
    const { clone } = cloneBehind("fail", "#!/bin/sh\necho boom >&2\nexit 3\n", "install.sh");
    const plan = planUpdate(info({ mode: "dev", source: clone }), readGitState(clone));
    assert.ok(plan.ok);
    // The dev steps, with the installer standing in for `npm install` and a marker for what must not run.
    const steps = [plan.steps[0], { argv: ["./install.sh"] }, { argv: ["touch", "restarted"], restart: true }];
    const paths = { log: join(DIR, "fail", "update.log"), status: join(DIR, "fail", "update-status.json") };
    const status = await runUpdate({ ...plan, steps }, paths);
    assert.equal(status.state, "failed");
    assert.equal(status.failed_step, "./install.sh");
    assert.equal(status.error, "exited with 3");
    assert.match(readFileSync(paths.log, "utf8"), /boom/);
    assert.equal(existsSync(join(clone, "restarted")), false, "nothing after the failure ran");

    const missing = await runUpdate({ ...plan, steps: [{ argv: ["aiball-no-such-command"] }] }, paths);
    assert.equal(missing.state, "failed");
    assert.match(missing.error ?? "", /ENOENT/);
});

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

test("the Windows runner: steps, log, status, no restart step, and the tray relaunched either way", { skip: !hasPwsh && "pwsh not installed" }, () => {
    for (const exit of [0, 4]) {
        const { clone } = cloneBehind(`win${exit}`, `Set-Content -Path installed.txt -Value "$args"\nWrite-Output "ps installer $args"\nexit ${exit}\n`, "install.ps1");
        const plan = planUpdate(info({ mode: "edge", source: clone }, "linux"), null);
        assert.ok(plan.ok);
        const tray = join(DIR, `tray${exit}.sh`);
        writeFileSync(tray, `#!/bin/sh\ntouch ${join(DIR, `tray${exit}.ran`)}\n`);
        chmodSync(tray, 0o755);
        const steps = [plan.steps[0], { argv: ["pwsh", "-NoProfile", "-File", "./install.ps1", "-Port", "7878"] }, { argv: ["touch", "restarted"], restart: true }];
        const paths = { log: join(DIR, `win${exit}`, "update.log"), status: join(DIR, `win${exit}`, "update-status.json") };
        const script = windowsRunnerScript({ ...plan, steps }, paths, tray);
        assert.doesNotMatch(script, /restarted/, "the tray restarts the daemon, not the runner");
        const runner = join(DIR, `runner${exit}.ps1`);
        writeFileSync(runner, script.replace("-WindowStyle Hidden", ""));
        const r = spawnSync("pwsh", ["-NoProfile", "-File", runner], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        const status = readUpdateStatus(paths.status)!;
        const log = readFileSync(paths.log, "utf8");
        assert.equal(readFileSync(join(clone, "VERSION"), "utf8").trim(), "v2", "pulled");
        assert.match(log, /ps installer -Port 7878/);
        if (exit === 0) {
            assert.equal(status.state, "ok", log);
        } else {
            assert.equal(status.state, "failed", log);
            assert.equal(status.failed_step, "pwsh -NoProfile -File ./install.ps1 -Port 7878");
        }
        for (let i = 0; i < 50 && !existsSync(join(DIR, `tray${exit}.ran`)); i++) spawnSync("sleep", ["0.1"]);
        assert.ok(existsSync(join(DIR, `tray${exit}.ran`)), "the tray was relaunched");
    }
});
