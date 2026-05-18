#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop Stop hook (#B.63). Runs at the end of every claude
 * turn inside a loop session. Mirrors the SessionStart hook's
 * "ping or sleep" logic (david: "hook stop -> ping ou sleep") —
 * runs the same check-cmd as the timer:
 *
 *   - check-cmd exit 0 (= still work to drain) → immediately
 *     `tmux send-keys` a random pop phrase so claude picks up the
 *     next thing without waiting for a timer tick
 *   - check-cmd non-zero (= nothing left) → write `idle-since` so
 *     the timer takes over the watch
 *
 * Always emits `{}` and exits 0 — never block claude's stop.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_USER_GRACE_SEC, MUX_CMD, WAKE_COALESCE_WINDOW_MS, checkHasWork, idleMarkerPath, lastWakeAtPath, pickPingPhrase, pingsPath, setTmuxStatus, tmuxName, userIsTakingOver, wakeInFlightPath } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
const userGraceSec = Math.max(0, Number(process.env.CL_USER_GRACE_SEC ?? DEFAULT_USER_GRACE_SEC));
if (!sd || !name) emit();

// #B.149: tail-friendly log of every Stop hook fire — so we can spot
// from outside the session whether the hook actually ran, what branch
// it took, and any error. Replaces the previous swallow-on-error
// silence that made misfires invisible. tail -f via
// `claude-loop tail <name> --stop-hook` (planned subcommand) or
// `tail -f ~/.claude-loop/<name>/stop-hook.log`.
function log(msg: string): void {
    try {
        appendFileSync(join(sd!, "stop-hook.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch { /* nowhere to log */ }
}

// #B.154: probe the visible pane for claude-side states that
// shouldn't get a wake. Compacting takes minutes (claude is busy
// summarizing the session); rate-limited / API errors mean any new
// send-keys will queue uselessly. Both surface in the tmux bar
// as transient `[busy:compacting]` / `[busy:rate-limit]` etc and
// suppress the auto-ping so we don't pile garbage into claude.
//
// #B.185: dropped the `working` (esc-to-interrupt) detection here.
// The Stop hook fires when claude has ENDED a turn — by definition
// not working anymore — so probing for "esc to interrupt" only
// caught stale footer text from the just-finished turn and
// suppressed the idle-since write, leaving the bar stuck on busy
// forever (david: "claude-loop reste encore en busy alors qu'on a
// fait plusieur tour de ping → hook stop"). Compacting/rate-limit/
// api-error stay because those are pane-persistent conditions that
// Claude legitimately reports even mid-turn.
function readPane(): string {
    try {
        const r = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tmuxName(name!)}.0`, "-p",
        ], { encoding: "utf8" });
        return r.stdout ?? "";
    } catch { return ""; }
}
type PaneState = { kind: "compacting" | "rate-limit" | "api-error" | "normal"; info: string };
function classifyPane(text: string): PaneState {
    if (/Compacting|compacting conversation|Summarizing the conversation/i.test(text)) {
        return { kind: "compacting", info: "compacting" };
    }
    if (/Rate limited|temporarily limiting requests/i.test(text)) {
        return { kind: "rate-limit", info: "rate-limit" };
    }
    if (/API Error|APIError/i.test(text)) {
        return { kind: "api-error", info: "api-error" };
    }
    return { kind: "normal", info: "" };
}

(async () => {
    log(`fire — checkCmd=${checkCmd}`);
    try {
        const paneState = classifyPane(readPane());
        if (paneState.kind !== "normal") {
            // Suppress wake — claude is doing something internal
            // (compacting, etc.) or blocked on backend. Surface the
            // SUB-STATE in the bar as a `busy:<info>` suffix.
            setTmuxStatus(name!, "busy", paneState.info);
            log(`  pane state = ${paneState.kind} → suppress wake, status busy:${paneState.info}`);
            emit();
        }
        // #B.195 — when the human typed within the user-grace window,
        // suppress the auto-ping. Otherwise the Stop hook fires
        // "Geronimo!" via send-keys right on top of the user's next
        // keystrokes ("pop culture en boucle"). The timer keeps
        // honoring user-took-over too, so nothing else wakes claude
        // until grace lapses. We still write idle-since so the bar
        // doesn't get stuck on busy when claude returns the prompt.
        if (userIsTakingOver(sd!, userGraceSec)) {
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, "idle");
            log(`  user-took-over within grace (${userGraceSec}s) → suppress wake, idle`);
            emit();
        }
        const hasWork = await checkHasWork(checkCmd);
        log(`  checkHasWork → ${hasWork}`);
        if (hasWork) {
            // #B.198 fix A: coalesce. If the previous wake fired
            // within the coalesce window, this Stop hook is the tail
            // of a burst (N events were unread, each turn drained one
            // and the chain rolls forward). Suppress the send-keys —
            // the next legit SSE event or heartbeat tick will wake
            // again, but without piling pop-culture phrases on top of
            // each other while claude is still visually finishing.
            const lastWakePath = lastWakeAtPath(sd!);
            const lastWakeMs = existsSync(lastWakePath) ? statSync(lastWakePath).mtimeMs : 0;
            const sinceLastWakeMs = Date.now() - lastWakeMs;
            if (lastWakeMs > 0 && sinceLastWakeMs < WAKE_COALESCE_WINDOW_MS) {
                writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
                setTmuxStatus(name!, "idle");
                log(`  → coalesced (last wake ${sinceLastWakeMs}ms < ${WAKE_COALESCE_WINDOW_MS}ms), idle marker set`);
                emit();
            }
            // Work still pending — ping immediately, don't enter idle.
            const phrase = pickPingPhrase(pingsPath(sd!));
            // #B.180: mark this send-keys as auto-wake so the
            // UserPromptSubmit hook skips user-took-over.
            try { writeFileSync(wakeInFlightPath(sd!), new Date().toISOString() + "\n"); } catch { /* ignore */ }
            // #B.198 fix A: also touch the coalesce marker so the
            // next Stop hook fire can detect "we just sent a wake".
            try { writeFileSync(lastWakeAtPath(sd!), new Date().toISOString() + "\n"); } catch { /* ignore */ }
            spawnSync(MUX_CMD, [
                "send-keys", "-t", `${tmuxName(name!)}.0`, phrase, "Enter",
            ], { stdio: "ignore" });
            setTmuxStatus(name!, "busy");
            log(`  → send-keys '${phrase}' + status busy`);
        } else {
            // Nothing to do — mark idle so the timer can take over.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, "idle");
            log(`  → idle-since + status idle`);
        }
    } catch (e) {
        log(`  ERROR ${(e as Error).message ?? String(e)}`);
    }
    emit();
})();
