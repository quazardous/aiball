// #3778 — a loop on the session host reloads: its respawned kernel gets the host's control socket, as `start` gives it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3778-"));
process.env.CLAUDE_LOOP_STATE_ROOT = root;
process.env.AIBALL_SOCK = "";
const { hostKernelEnv } = await import("./manage.js");
after(() => rmSync(root, { recursive: true, force: true }));

test("on the host: CL_HOST_CONTROL is the control socket in the plate's host_dir; in tmux: nothing", () => {
    const sd = mkdtempSync(join(root, "cl-x-"));
    writeFileSync(join(sd, "plate.json"), JSON.stringify({ name: "cl-x", host_agent: "x-claude", host_dir: "/home/u/.local/share/aiball/hosts/x-claude" }));
    assert.deepEqual(hostKernelEnv(sd, true), { CL_HOST_CONTROL: "/home/u/.local/share/aiball/hosts/x-claude/control.sock" });
    assert.deepEqual(hostKernelEnv(sd, false), {});
});
