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
import { writeFileSync } from "node:fs";
import { AiballClient } from "../client.js";
import { MUX_CMD, idleMarkerPath, pickPingPhrase, pingsPath, tmuxName } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
if (!sd || !name) emit();

const DEFAULT_AIBALL_CHECK = "aiball pings-count -q";

async function checkHasWork(): Promise<boolean> {
    if (!checkCmd || checkCmd === "true") return true;
    if (checkCmd === DEFAULT_AIBALL_CHECK) {
        try {
            const r = await new AiballClient().pingsCount() as { unread?: number };
            return (r.unread ?? 0) > 0;
        } catch {
            return false;
        }
    }
    const r = spawnSync("bash", ["-c", checkCmd], { stdio: "ignore" });
    return r.status === 0;
}

(async () => {
    try {
        if (await checkHasWork()) {
            // Work still pending — ping immediately, don't enter idle.
            const phrase = pickPingPhrase(pingsPath(sd!));
            spawnSync(MUX_CMD, [
                "send-keys", "-t", `${tmuxName(name!)}.0`, phrase, "Enter",
            ], { stdio: "ignore" });
        } else {
            // Nothing to do — mark idle so the timer can take over.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
        }
    } catch {
        /* swallow — never block stop */
    }
    emit();
})();
