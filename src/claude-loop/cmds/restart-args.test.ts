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
        "--interval", "60",
        "--check-cmd", "aiball pings-count -q",
        "--force",
        "--no-attach",
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
