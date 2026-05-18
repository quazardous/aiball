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
import { DEFAULT_USER_GRACE_SEC, MUX_CMD, WAKE_COALESCE_WINDOW_MS, checkHasWork, idleMarkerPath, lastWakeAtPath, pickPingPhrase, pingsPath, setTmuxStatus, tmuxName, userIsTakingOver, userTookOverPath, wakeInFlightPath } from "./state.js";

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

/**
 * Compact characterization of the TURN that just ended (#B.198).
 *
 * By definition the Stop hook fires post-turn, so "was the loop
 * busy?" is always yes — useless. What david actually wants is "what
 * kind of turn was this": user-driven, auto-wake-driven, or
 * autonomous (claude continued on its own). Comparison of marker
 * ages gives a reliable signal:
 *   - whichever of user-took-over / last-wake is more recent wins
 *   - if both are stale (> userGraceSec), call it "autonomous"
 *   - if neither marker exists → "?" (first fire / pruned state)
 *
 * The trailing markers stay raw so the reader can sanity-check the
 * classification or spot edge cases (wake-in-flight still set = the
 * UserPromptSubmit hook didn't get a chance to clean up).
 */
function ageMs(p: string): number | null {
    if (!existsSync(p)) return null;
    try { return Date.now() - statSync(p).mtimeMs; }
    catch { return null; }
}
function fmt(ms: number | null): string {
    return ms === null ? "-" : `${Math.round(ms / 1000)}s`;
}
function classifyTurn(): string {
    const wake = ageMs(lastWakeAtPath(sd!));
    const user = ageMs(userTookOverPath(sd!));
    const inflight = ageMs(wakeInFlightPath(sd!));
    // Whichever marker is more recent likely triggered THIS turn —
    // no time cutoff (claude turns can legitimately run minutes on
    // tool chains, so capping by user-grace mis-labeled long
    // auto-wake replies as "autonomous").
    let turn = "?";
    if (wake === null && user === null) turn = "?";
    else if (user !== null && (wake === null || user <= wake)) turn = "user";
    else turn = "auto-wake";
    return `turn=${turn} last-wake=${fmt(wake)} user-took-over=${fmt(user)} wake-in-flight=${fmt(inflight)}`;
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
    log(`FIRE — ${classifyTurn()} | checkCmd=${checkCmd}`);
    try {
        const paneState = classifyPane(readPane());
        if (paneState.kind !== "normal") {
            // Suppress wake — claude is doing something internal
            // (compacting, etc.) or blocked on backend. Surface the
            // SUB-STATE in the bar as a `busy:<info>` suffix.
            setTmuxStatus(name!, "busy", paneState.info);
            log(`  → SUPPRESS (pane=${paneState.kind}) became=busy:${paneState.info}`);
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
            // David #B.198: plain `[idle]` here mis-signaled "ready
            // for wakes" — we're actually deferring wakes. Surface
            // the user-grace caveat in the bar so the human reads it
            // as "claude IS at prompt, but we won't poke during grace".
            setTmuxStatus(name!, "idle", "user");
            log(`  → SUPPRESS (user-grace<${userGraceSec}s) became=idle:user`);
            emit();
        }
        const hasWork = await checkHasWork(checkCmd);
        log(`  checkHasWork=${hasWork}`);
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
                log(`  → COALESCE (last-wake=${sinceLastWakeMs}ms<${WAKE_COALESCE_WINDOW_MS}ms) became=idle`);
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
            log(`  → WAKE '${phrase}' became=busy`);
        } else {
            // Nothing to do — mark idle so the timer can take over.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, "idle");
            log(`  → IDLE (no work) became=idle`);
        }
    } catch (e) {
        log(`  → ERROR ${(e as Error).message ?? String(e)}`);
    }
    emit();
})();
