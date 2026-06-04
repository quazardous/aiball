#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop UserPromptSubmit hook (#B.145 v2.2). Fires whenever a
 * prompt is submitted in the claude-loop tmux pane — by the human OR
 * by claude-loop's own auto-wake send-keys. Purpose since #745
 * phase B:
 *
 *   - **Distinguish human submission from auto-wake.** The timer
 *     and Stop hook touch a `wake-in-flight` marker right before
 *     their own send-keys. On fire, this hook reads the marker:
 *     if fresh (mtime within WAKE_IN_FLIGHT_TTL_MS), the prompt is
 *     ours → `from_auto_wake=true`. Otherwise it's a human
 *     submission. The flag is emitted on the `UserPromptSubmit`
 *     event so the timer can keep its in-memory `idleSinceMs`
 *     for auto-wakes and clear it for human submissions.
 *
 *   - **Busy-state precision** — emit the `UserPromptSubmit` event
 *     so the HookService bar subscriber (`hook-bar-subscriber.ts`)
 *     flips the tmux status to `[busy]` immediately. Without this
 *     the bar would lag until the next Stop hook. Best-effort emit:
 *     if the timer is down the bar lag returns, the idle-since
 *     cleanup still runs.
 *
 * Always emits `{}` and exits 0 — never block claude's run.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import {
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
    // #727 V1 Slice B-3 — try the ws emit first ; the timer-side
    // subscriber clears the in-memory `idleSinceMs` (Slice B-1). #793 —
    // no file fallback; the bus is the single source of truth.
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
