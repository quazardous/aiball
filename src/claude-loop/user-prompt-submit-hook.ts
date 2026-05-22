#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop UserPromptSubmit hook (#B.145 v2.2). Fires whenever a
 * prompt is submitted in the claude-loop tmux pane — by the human OR
 * by claude-loop's own auto-wake send-keys. Two purposes:
 *
 *   1. **user-took-over tracking** — refresh the `user-took-over`
 *      marker (mtime = now) when the prompt came from the HUMAN.
 *      The timer + Stop hook honor a grace window
 *      (CL_USER_GRACE_SEC, default 60s) and skip auto-pings while
 *      the human is recently active. Prevents the wrapper from
 *      `send-keys`-ing a wake-up over a prompt the human is mid-
 *      typing.
 *
 *      **#B.180**: claude-loop's OWN wake-keys triggered this hook
 *      too, locking subsequent wakes for 5 min — a self-inflicted
 *      wound. Fix: timer/stop-hook touch a `wake-in-flight` marker
 *      before send-keys; this hook checks the marker on fire and
 *      skips the user-took-over touch when fresh (mtime within
 *      WAKE_IN_FLIGHT_TTL_MS). Marker then deleted.
 *
 *   2. **busy-state precision** — flip the tmux status to `[busy]`
 *      immediately (claude is about to process the prompt). Without
 *      this, the bar would lag until the next Stop hook flips it
 *      back. Also clears `idle-since` so the timer correctly sees
 *      "claude is in a turn".
 *
 * Always emits `{}` and exits 0 — never block claude's run.
 */
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import {
    idleMarkerPath,
    setTmuxStatus,
    userTookOverPath,
    wakeInFlightPath,
    WAKE_IN_FLIGHT_TTL_MS,
} from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
if (!sd || !name) emit();

try {
    // #B.180: detect "this prompt came from claude-loop's own wake".
    // If the wake-in-flight marker exists AND is fresh, the timer or
    // stop-hook touched it microseconds before its send-keys reached
    // here — DON'T treat as user activity. Always clean up the
    // marker after the check so it doesn't linger.
    const wifPath = wakeInFlightPath(sd!);
    let fromAutoWake = false;
    if (existsSync(wifPath)) {
        try {
            const age = Date.now() - statSync(wifPath).mtimeMs;
            if (age < WAKE_IN_FLIGHT_TTL_MS) fromAutoWake = true;
        } catch { /* stat race — treat as human */ }
        try { unlinkSync(wifPath); } catch { /* race */ }
    }
    if (!fromAutoWake) {
        writeFileSync(userTookOverPath(sd!), new Date().toISOString() + "\n");
    }
    if (existsSync(idleMarkerPath(sd!))) {
        try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    }
    setTmuxStatus(name!, "busy");
} catch {
    /* swallow — never block submit */
}
emit();
