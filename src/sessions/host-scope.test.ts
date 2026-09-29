/**
 * #3333 — the session hosts live in the daemon's cgroup: a restart of the
 * systemd service killed every host and the Claude in it. Under systemd a host
 * now starts in a scope of its own; an agent's host ends with its Claude.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const home = mkdtempSync("/tmp/aiball-hostscope-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const { hostScope, startHost, sessionHostBin } = await import("./hosts.js");
after(() => rmSync(home, { recursive: true, force: true }));

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

test("outside a systemd service, or without systemd-run, the host starts as before", () => {
    assert.equal(hostScope("/h/tvty-claude", env, {}, () => true), null, "no INVOCATION_ID: not a service");
    assert.equal(hostScope("/h/tvty-claude", env, { INVOCATION_ID: "x" }, () => false), null, "no systemd-run");
});

test("under a service: a scope of its own, reachable through the user manager", () => {
    if (process.platform !== "linux") return;
    const s = hostScope("/h/tvty claude", env, { INVOCATION_ID: "x", XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/b" }, () => true);
    assert.ok(s);
    assert.equal(s.cmd, "systemd-run");
    assert.deepEqual(s.args.slice(0, 4), ["--user", "--scope", "--quiet", "--collect"]);
    assert.match(s.args[4]!, /^--unit=aiball-host-tvty_claude-\d+$/);
    assert.equal(s.args.at(-1), "--");
    assert.equal(s.env.XDG_RUNTIME_DIR, "/run/user/1");
    assert.equal(s.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/b");
    assert.equal(s.env.PATH, env.PATH);
});

const scopes = process.platform === "linux"
    && spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore" }).status === 0;

test("a real host under a service lands in its own scope, and ends with its command", { skip: !scopes || !existsSync(sessionHostBin()) ? "no user systemd or no host binary" : false }, async () => {
    const saved = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = "aiball-test";
    try {
        const link = await startHost({ agent: "scope-test", argv: ["sh", "-c", "sleep 1"], cwd: home, env: { ...env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" } });
        const pid = link.info.pid;
        const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
        assert.match(cgroup, /aiball-host-scope-test-\d+\.scope/, cgroup);
        link.close();
        const deadline = Date.now() + 5000;
        while (existsSync(`/proc/${pid}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        assert.equal(existsSync(`/proc/${pid}`), false, "the agent's host went with its command");
    } finally {
        if (saved === undefined) delete process.env.INVOCATION_ID; else process.env.INVOCATION_ID = saved;
    }
});
