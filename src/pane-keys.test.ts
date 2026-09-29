/**
 * #3247 — keys typed into a tmux loop's pane tell the loop a human is typing
 * before they go: `send-keys` goes around the PTY proxy that would have said
 * so. The relay on a proxy node used to send the keys alone, so the loop's
 * wake gate could inject a prompt over them. Both paths now share sendLoopKeys.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3247-"));
after(() => rmSync(root, { recursive: true, force: true }));
const log = join(root, "order.log");
// A tmux stand-in: it notes when the keys arrive.
const fakeMux = join(root, "fake-tmux");
writeFileSync(fakeMux, `#!/bin/sh\necho "keys $*" >> '${log}'\n`);
chmodSync(fakeMux, 0o755);
process.env.MUX_CMD = fakeMux;
process.env.CLAUDE_LOOP_STATE_ROOT = join(root, "loops");
mkdirSync(join(root, "loops", "cl-demo"), { recursive: true });

const { sendLoopKeys } = await import("./pane.js");
const { listenEvents } = await import("./claude-loop/ipc-events.js");
const { loopSockPath } = await import("./claude-loop/state.js");

test("the loop hears the typing marker with the keys that reach its pane", async () => {
    const server = listenEvents(loopSockPath(join(root, "loops", "cl-demo")), (ev) => {
        const d = ev.data as { event?: string; name?: string } | undefined;
        if (ev.kind === "proxyEvent" && d?.event === "marker") writeFileSync(log, `marker ${d.name}\n`, { flag: "a" });
    });
    try {
        await new Promise((r) => setTimeout(r, 50));
        const r = await sendLoopKeys("cl-demo", "hello");
        assert.deepEqual(r, { ok: true });
        await new Promise((r) => setTimeout(r, 300));
        const lines = readFileSync(log, "utf8").trim().split("\n");
        assert.ok(lines.includes("marker touch_marker"), lines.join(" | "));
        assert.ok(lines.some((l) => /^keys send-keys -l -t cl-demo\S* -- hello$/.test(l)), lines.join(" | "));
    } finally {
        server.close();
    }
});

test("no loop listening: the keys still go", async () => {
    writeFileSync(log, "");
    const r = await sendLoopKeys("cl-gone", "x");
    assert.deepEqual(r, { ok: true });
    assert.match(readFileSync(log, "utf8"), /^keys send-keys/);
});
