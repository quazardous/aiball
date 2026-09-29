/**
 * #1576 — what a `restart` replays from the plate.
 *
 * The bug was an omission: `--role` / `--consumer` / `--project` were passed at
 * launch and recorded nowhere, so a crew loop came back as the lead. An
 * omission in an inline array is invisible; as a pure function it is one
 * assertion.
 *
 * Run: `npx tsx --test src/claude-loop/cmds/restart-args.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartStartArgs } from "./manage.js";
import type { Plate } from "../state.js";

function plate(over: Partial<Plate> = {}): Plate {
    return {
        name: "cl-aiball-abc123",
        created_at: "2026-07-27T00:00:00.000Z",
        interval: 60,
        check_cmd: "aiball pings-count -q",
        pings_path: "/tmp/sd/pings.yaml",
        cwd: "/repo",
        claude_args: [],
        ...over,
    };
}

/** The flag's value, or null when the flag is absent. */
function flag(args: string[], name: string): string | null {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
}

test("#1576 a crew plate replays its role AND its identity", () => {
    const args = restartStartArgs("cl-aiball-crew", plate({
        role: "crew",
        consumer: "aiball-crew-infra",
        project: "aiball",
        // The point of the bug: a local crew has NO remote block, and the
        // identity used to be persisted only inside that block.
        remote: null,
    }));
    assert.equal(flag(args, "--role"), "crew");
    assert.equal(flag(args, "--consumer"), "aiball-crew-infra");
    assert.equal(flag(args, "--project"), "aiball");
});

test("#1576 a plate written before the fix replays exactly what it used to", () => {
    // Degrade, don't invent: an older plate has none of the three, and must
    // produce the pre-fix invocation rather than flags nobody recorded.
    const args = restartStartArgs("cl-aiball-abc123", plate());
    assert.deepEqual(args, [
        "start",
        "--name", "cl-aiball-abc123",
        // #3360 — where it ran, said: never a folder taken from the environment.
        "--cwd", "/repo",
        "--interval", "60",
        "--check-cmd", "aiball pings-count -q",
        "--force",
        "--no-attach",
        // #3135 — said explicitly, so the host default does not move it.
        "--tmux",
    ]);
});

test("#390 a remote plate still replays its connection and identity", () => {
    const args = restartStartArgs("cl-remote", plate({
        remote: { url: "https://box:7777", token: "tok", consumer: "remote-agent", project: "proj" },
    }));
    assert.equal(flag(args, "--aiball-url"), "https://box:7777");
    assert.equal(flag(args, "--aiball-token"), "tok");
    // Read through the remote block when the top-level fields are absent.
    assert.equal(flag(args, "--consumer"), "remote-agent");
    assert.equal(flag(args, "--project"), "proj");
    assert.equal(flag(args, "--role"), null);
});

test("#1576 the top-level identity wins, and the flag is not emitted twice", () => {
    const args = restartStartArgs("cl-both", plate({
        consumer: "top-level",
        project: "top-project",
        remote: { url: "https://box:7777", consumer: "stale-remote", project: "stale-project" },
    }));
    assert.equal(flag(args, "--consumer"), "top-level");
    assert.equal(flag(args, "--project"), "top-project");
    assert.equal(args.filter((a) => a === "--consumer").length, 1);
    assert.equal(args.filter((a) => a === "--project").length, 1);
});

test("claude passthrough args stay last, after the `--` separator", () => {
    const args = restartStartArgs("cl-args", plate({
        role: "crew",
        claude_args: ["--permission-mode", "auto"],
    }));
    const dash = args.indexOf("--");
    assert.notEqual(dash, -1);
    assert.deepEqual(args.slice(dash + 1), ["--permission-mode", "auto"]);
    // The role must sit BEFORE the separator, or claude would receive it.
    assert.ok(args.indexOf("--role") < dash);
});

test("#3066 --host moves a loop onto the session host, and a loop already there stays", () => {
    assert.ok(!restartStartArgs("n", plate()).includes("--host"), "a tmux loop stays in tmux");
    const moved = restartStartArgs("n", plate(), { resume: true, host: true });
    assert.ok(moved.includes("--host") && moved.includes("--resume"), "moved, with its conversation");
    assert.ok(restartStartArgs("n", plate({ host_agent: "worker" })).includes("--host"), "a host loop restarts on the host");
    assert.ok(moved.indexOf("--host") < moved.indexOf("--") || !moved.includes("--"), "a start flag, before Claude's own arguments");
    const withArgs = restartStartArgs("n", plate({ claude_args: ["--model", "x"] }), { host: true });
    assert.ok(withArgs.indexOf("--host") < withArgs.indexOf("--"), "never passed to Claude");
});

test("#3135 a loop stays where it runs, whatever the configured default; --tmux moves it back", () => {
    const tmux = restartStartArgs("n", plate());
    assert.ok(tmux.includes("--tmux") && !tmux.includes("--host"), "a tmux loop says so: a host default must not move it");
    const back = restartStartArgs("n", plate({ host_agent: "worker" }), { resume: true, tmux: true });
    assert.ok(back.includes("--tmux") && !back.includes("--host") && back.includes("--resume"), "moved off the host, its conversation kept");
    const withArgs = restartStartArgs("n", plate({ claude_args: ["--model", "x"] }));
    assert.ok(withArgs.indexOf("--tmux") < withArgs.indexOf("--"), "never passed to Claude");
});

test("#3174 — restart --fresh starts with --no-resume (a fresh conversation); a plain one does not", () => {
    assert.ok(restartStartArgs("cl-x", plate(), { fresh: true }).includes("--no-resume"));
    assert.ok(!restartStartArgs("cl-x", plate()).includes("--no-resume"));
});

test("#3254 — the loop's Remote Control choice is replayed; a new one replaces it; none leaves the setting", () => {
    const flags = (args: string[]) => args.filter((a, i) => a.includes("remote-control") || args[i - 1] === "--remote-control");
    assert.deepEqual(flags(restartStartArgs("n", plate())), [], "no choice: the setting decides again");
    assert.deepEqual(flags(restartStartArgs("n", plate({ remote_control_override: "phone" }))), ["--remote-control", "phone"]);
    assert.deepEqual(flags(restartStartArgs("n", plate({ remote_control_override: false }))), ["--no-remote-control"]);
    assert.deepEqual(flags(restartStartArgs("n", plate({ remote_control_override: false }), { remoteControl: true })), ["--remote-control"]);
    const withArgs = restartStartArgs("n", plate({ remote_control_override: true, claude_args: ["--model", "x"] }));
    assert.ok(withArgs.indexOf("--remote-control") < withArgs.indexOf("--"), "a start flag, never passed to Claude as such");
});

test("#3236 — a reload typed in another loop's shell does not hand the reloaded kernel that loop's host or identity", async () => {
    const { reloadSpawnEnv } = await import("./manage.js");
    const { REATTACH_ENV_VAR } = await import("../respawn-state.js");
    const caller = {
        PATH: "/usr/bin",
        CL_STATE_DIR: "/loops/cl-caller", CL_NAME: "cl-caller", CL_HOST_CONTROL: "/hosts/caller/control.sock",
        AIBALL_AGENT: "caller-agent", CL_LOG_LEVEL: "debug",
    };
    const record = { CL_STATE_DIR: "/loops/cl-caller", CL_NAME: "cl-caller", AIBALL_AGENT: "caller-agent" };
    const env = reloadSpawnEnv(caller, null, () => record);
    for (const k of ["CL_STATE_DIR", "CL_NAME", "CL_HOST_CONTROL", "AIBALL_AGENT"]) assert.equal(env[k], undefined, `${k} is the caller's, not the reloaded loop's`);
    assert.equal(env.CL_LOG_LEVEL, "debug", "a value the caller set itself is kept");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env[REATTACH_ENV_VAR], "1", "the reattach mark");
    assert.equal(caller.CL_HOST_CONTROL, "/hosts/caller/control.sock", "the caller's own environment is not touched");
});

test("#3239 — prune offers the dead loops only: never a hidden lock, the root's log, or a loop that runs", async () => {
    const { pruneCandidates } = await import("./manage.js");
    const entries = [".start-lock-d077aa", "restart.log", "cl-dead", "cl-alive", "cl-on-host"];
    const loops = new Set(["cl-dead", "cl-alive", "cl-on-host", ".start-lock-d077aa"]);
    const alive = new Set(["cl-alive", "cl-on-host"]);
    assert.deepEqual(pruneCandidates(entries, (n) => loops.has(n), (n) => alive.has(n)), ["cl-dead"]);
});

test("#3281 — a start clears only broken state dirs (no plate), never a stopped loop kept for its restart", async () => {
    const { startSweepTargets } = await import("./manage.js");
    const entries = [".start-lock-a1", "cl-stopped", "cl-broken", "cl-running", "cl-broken-running"];
    const plates = new Set(["cl-stopped", "cl-running"]);
    const alive = new Set(["cl-running", "cl-broken-running"]);
    assert.deepEqual(startSweepTargets(entries, (n) => plates.has(n), (n) => alive.has(n)), ["cl-broken"]);
});
