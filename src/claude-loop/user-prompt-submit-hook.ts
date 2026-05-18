#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop UserPromptSubmit hook (#B.145 v2.2). Fires whenever
 * the human types a prompt and submits it in the claude-loop tmux
 * pane. Two purposes:
 *
 *   1. **user-took-over tracking** — refresh the `user-took-over`
 *      marker (mtime = now). The timer + Stop hook honor a grace
 *      window (CL_USER_GRACE_SEC, default 300s) and skip auto-pings
 *      while the human is recently active. Prevents the wrapper from
 *      `send-keys`-ing a wake-up over a prompt the human is mid-typing.
 *
 *   2. **busy-state precision** — flip the tmux status to `[busy]`
 *      immediately (claude is about to process the prompt). Without
 *      this, the bar would lag until the next Stop hook flips it
 *      back. Also clears `idle-since` so the timer correctly sees
 *      "claude is in a turn".
 *
 * Always emits `{}` and exits 0 — never block claude's run.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { idleMarkerPath, setTmuxStatus, userTookOverPath } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
if (!sd || !name) emit();

try {
    writeFileSync(userTookOverPath(sd!), new Date().toISOString() + "\n");
    if (existsSync(idleMarkerPath(sd!))) {
        try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    }
    setTmuxStatus(name!, "busy");
} catch {
    /* swallow — never block submit */
}
emit();
