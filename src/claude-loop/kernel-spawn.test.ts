/**
 * #3483 — a kernel spawned from inside the aiball service (a `session.start`
 * runs `claude-loop start` from the daemon) lived in the service's cgroup:
 * `aiball restart` sent it SIGTERM and it stopped its loop, Claude with it.
 * Under systemd it now starts in a scope of its own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { kernelScope } from "./kernel-spawn.js";

const tmp = mkdtempSync("/tmp/aiball-kernelscope-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

test("outside a systemd unit, or when the user manager starts no scope, the kernel starts as before", () => {
    assert.equal(kernelScope("/s/cl-demo", env, {}, () => true, () => true), null, "no INVOCATION_ID");
    assert.equal(kernelScope("/s/cl-demo", env, { INVOCATION_ID: "x" }, () => false, () => true), null, "the manager did not start one");
    assert.equal(kernelScope("/s/cl-demo", env, { INVOCATION_ID: "x" }, () => true, () => false), null, "no systemd-run");
});

test("inside a unit: a scope named after the loop", () => {
    if (process.platform !== "linux") return;
    const s = kernelScope("/s/cl-demo-1a2b", env, { INVOCATION_ID: "x", XDG_RUNTIME_DIR: "/run/user/1" }, () => true, () => true);
    assert.ok(s);
    assert.match(s.args.find((a) => a.startsWith("--unit="))!, /^--unit=aiball-kernel-cl-demo-1a2b-\d+$/);
    assert.equal(s.env.XDG_RUNTIME_DIR, "/run/user/1");
});

const scopes = process.platform === "linux"
    && spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore" }).status === 0;

/**
 * Spawn a kernel from inside a transient service, stop the service as
 * `aiball restart` does, and say whether the kernel lived, and in which cgroup.
 * `scoped: false` spawns it as before the fix, to show what the scope changes.
 */
async function kernelThroughServiceStop(name: string, scoped: boolean): Promise<{ cgroup: string; survived: boolean }> {
    // The loop's state dir and a stand-in for tsx: the kernel's command line
    // is the real one, what it runs only sleeps.
    const sd = join(tmp, name);
    mkdirSync(sd);
    writeFileSync(join(sd, "env"), "");
    const tsx = join(tmp, "fake-tsx");
    writeFileSync(tsx, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(tsx, 0o755);
    const launcher = join(tmp, `${name}.ts`);
    writeFileSync(launcher, [
        `import { spawnKernel } from ${JSON.stringify(resolve(import.meta.dirname, "kernel-spawn.ts"))};`,
        ...(scoped ? [] : ["delete process.env.INVOCATION_ID;"]),
        `spawnKernel(${JSON.stringify(sd)}, ${JSON.stringify(tmp)}, ${JSON.stringify(tsx)}, process.env);`,
        "setInterval(() => {}, 1000);",
    ].join("\n"));
    const unit = `aiball-kernelscope-test-${Date.now()}`;
    const tsxBin = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
    // The stand-in daemon: a service, as aiball.service is.
    const run = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, `--setenv=PATH=${env.PATH}`, tsxBin, launcher], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    try {
        const pidFile = join(sd, "loop.pid");
        let deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        // The exec chain (systemd-run → bash → the stand-in) lands on sleep.
        deadline = Date.now() + 5000;
        while (!/sleep/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
        // What `aiball restart` does to the service: stop it, its cgroup with it.
        spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 300));
        const survived = existsSync(`/proc/${pid}`);
        if (survived) process.kill(pid, "SIGKILL");
        return { cgroup, survived };
    } finally {
        spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    }
}

test("a kernel spawned from a service outlives the service's stop, in its own scope", { skip: scopes ? false : "no user systemd" }, async () => {
    const r = await kernelThroughServiceStop("cl-scope-test", true);
    assert.match(r.cgroup, /aiball-kernel-cl-scope-test-\d+\.scope/);
    assert.equal(r.survived, true, "the kernel outlived the service's stop");
});

test("without its scope, the service's stop takes the kernel with it (the bug)", { skip: scopes ? false : "no user systemd" }, async () => {
    const r = await kernelThroughServiceStop("cl-noscope-test", false);
    assert.match(r.cgroup, /aiball-kernelscope-test-\d+\.service/);
    assert.equal(r.survived, false);
});
