#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop UserPromptSubmit hook (#B.145 v2.2 ; #778 david `3p3tp5`
 * full-IPC migration). Fires whenever a prompt is submitted in the
 * claude-loop tmux pane — by the human OR by claude-loop's own
 * auto-wake send-keys.
 *
 * Single job today : emit the `UserPromptSubmit` hook event on the
 * timer's loop.sock so the HookService bar subscriber flips the bar
 * to `[busy]` immediately + the timer can resolve `from_auto_wake`
 * via its in-memory `ipcState.lastWakeAtMs` (timer-side derivation,
 * #778) — no file-marker round-trip from this subprocess. Best-effort
 * emit ; if the timer is down the bar lag returns silently and the
 * prompt still goes through.
 *
 * Always emits `{}` and exits 0 — never blocks claude's run.
 */
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
    // The timer-side dispatcher (`proxy-event-dispatcher.ts`) compares
    // `at_ms` with `ipcState.lastWakeAtMs` — within WAKE_IN_FLIGHT_TTL_MS
    // it sets `from_auto_wake=true`. We forward the timestamp only ;
    // truth lives in the timer's IPC state.
    await emitHookEventToTimer(sd!, {
        event: "hook",
        kind: "UserPromptSubmit",
        at_ms: Date.now(),
    });
} catch {
    /* swallow — never block submit */
}
emit();
