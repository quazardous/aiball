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
 *      back.
 *
 *      **#652 Slice 6** — the direct `setTmuxStatus(BUSY)` call moved
 *      to a HookService subscriber on the timer side. This hook now
 *      emits a `UserPromptSubmit` event carrying `from_auto_wake`,
 *      and the subscriber (`hook-bar-subscriber.ts`) flips the bar.
 *      Best-effort emit : if the timer is down the bar lag returns,
 *      but the hook's other side-effects (user-took-over marker,
 *      idle-since cleanup) still run.
 *
 * Always emits `{}` and exits 0 — never block claude's run.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import {
    idleMarkerPath,
    wakeInFlightPath,
    WAKE_IN_FLIGHT_TTL_MS,
} from "./state.js";
import { CL_ENV } from "./env-vars.js";
import { emitHookEventToTimer } from "./hook-emit.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
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
    // #745 phase B — user-took-over marker dropped (AFK SM owns the
    // "human present" signal end-to-end now). `fromAutoWake` is still
    // carried on the hook event below so the timer-side handler can
    // distinguish auto-wake submissions from real human prompts.
    if (existsSync(idleMarkerPath(sd!))) {
        try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    }
    // #652 Slice 6 — emit the event ; the timer-side subscriber paints
    // the bar BUSY. Best-effort : silent no-op if the timer isn't up
    // (the bar lags to the next heartbeat tick, acceptable degraded mode).
    await emitHookEventToTimer(sd!, {
        event: "hook",
        kind: "UserPromptSubmit",
        from_auto_wake: fromAutoWake,
        at_ms: Date.now(),
    });
} catch {
    /* swallow — never block submit */
}
emit();
