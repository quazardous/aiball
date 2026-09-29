// #3168 — a folder's loops, a lead and its crew: each agent resolves its own, never another agent's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3168-"));
process.env.CLAUDE_LOOP_STATE_ROOT = root;
const { resolveLoopName } = await import("./pane.js");
after(() => rmSync(root, { recursive: true, force: true }));

function plate(dir: string, fields: Record<string, unknown>, ageSec = 0): void {
    mkdirSync(join(root, dir), { recursive: true });
    const p = join(root, dir, "plate.json");
    writeFileSync(p, JSON.stringify({ cwd: "/w", ...fields }));
    const t = Date.now() / 1000 - ageSec;
    utimesSync(p, t, t);
}

plate("cl-lead-old", {}, 100);                                    // the lead, from before `agent`: names nobody
plate("cl-tmux-a", { consumer: "tmux-a", host_agent: null }, 50); // a crew from before `agent`
plate("cl-host-a", { host_agent: "host-a" }, 10);                 // the newest of the folder, on the host
plate("cl-crew-b", { agent: "crew-b", consumer: "crew-b" }, 20);
plate("cl-elsewhere", { agent: "tmux-a", cwd: "/other" }, 0);

test("each agent gets its own loop, whatever the newest of the folder", () => {
    assert.equal(resolveLoopName("/w", "tmux-a"), "cl-tmux-a");
    assert.equal(resolveLoopName("/w", "host-a"), "cl-host-a");
    assert.equal(resolveLoopName("/w", "crew-b"), "cl-crew-b");
});

test("an agent with no plate of its own: the plate that names nobody (the folder's lead), never another agent's", () => {
    assert.equal(resolveLoopName("/w", "lead"), "cl-lead-old");
    plate("cl-lead-old", { agent: "lead" }, 100);
    assert.equal(resolveLoopName("/w", "someone"), null, "every plate names an agent now, none of them this one");
});

test("two plates of one agent: the latest started", () => {
    plate("cl-crew-b-new", { agent: "crew-b" }, 1);
    assert.equal(resolveLoopName("/w", "crew-b"), "cl-crew-b-new");
});

// #3246 — the daemon compares canonical folders, as the CLI does: a loop started
// through a symlinked path is found from the real one, and the other way round.
test("a folder reached through a symlink is the same folder", () => {
    const real = mkdtempSync(join(tmpdir(), "aiball-3246-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
        plate("cl-via-link", { agent: "linked", cwd: link }, 0);
        assert.equal(resolveLoopName(real, "linked"), "cl-via-link", "the plate holds the symlink, the agent the real path");
        plate("cl-via-real", { agent: "real-one", cwd: real }, 0);
        assert.equal(resolveLoopName(link, "real-one"), "cl-via-real", "the plate holds the real path, the agent the symlink");
    } finally {
        rmSync(link, { force: true });
        rmSync(real, { recursive: true, force: true });
    }
});
