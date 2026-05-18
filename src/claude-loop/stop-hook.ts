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
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MUX_CMD, checkHasWork, idleMarkerPath, pickPingPhrase, pingsPath, setTmuxStatus, tmuxName } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
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

(async () => {
    log(`fire — checkCmd=${checkCmd}`);
    try {
        const hasWork = await checkHasWork(checkCmd);
        log(`  checkHasWork → ${hasWork}`);
        if (hasWork) {
            // Work still pending — ping immediately, don't enter idle.
            const phrase = pickPingPhrase(pingsPath(sd!));
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
