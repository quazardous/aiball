#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop SessionStart hook (#B.63 v2.1 follow-up). Runs once
 * when a claude session opens. Replaces the fragile `sleep 3 &&
 * tmux send-keys` hack the wrapper used to schedule a startup ping:
 * now the ping is gated on the SAME conditions as a timer tick (idle
 * check + check-cmd exit code), but triggered AT the moment the
 * session is actually ready (no race with claude's own startup
 * prompts — MCP-server-trust, etc).
 *
 * David #B.63: "y a un bug lorsque claude demande des choses au
 * startup. donc il faut voir s'il y a un hook qui se déclanche
 * quand la session s'ouvre" + "on attend que la session s'ouvre
 * complètement pour déclencher le ping (ou pas) et entrer dans
 * l'idle".
 *
 * Behavior:
 *   - Always emits `{}` and exits 0 (never block claude's session
 *     boot — the hook's purpose is observation + side-effect, not
 *     gating).
 *   - If `CL_NO_STARTUP_PING` is set, no-op (user opted out via
 *     `claude-loop --no-startup-ping`).
 *   - Otherwise run the same check-cmd the timer would: on exit 0,
 *     `tmux send-keys` a random ping phrase into pane 0. On non-
 *     zero, do nothing — claude is idle, the timer takes over from
 *     here.
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
const noStartup = process.env.CL_NO_STARTUP_PING === "1";
if (!sd || !name || noStartup) emit();

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
            const phrase = pickPingPhrase(pingsPath(sd!));
            spawnSync(MUX_CMD, [
                "send-keys", "-t", `${tmuxName(name!)}.0`, phrase, "Enter",
            ], { stdio: "ignore" });
        } else {
            // Nothing to do at boot — mark idle so the timer takes
            // over the watch immediately (no need to wait for claude's
            // first Stop). Mirrors the Stop hook's "sleep" branch.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
        }
    } catch {
        /* swallow — never block startup */
    }
    emit();
})();
