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
import { readFileSync, writeFileSync } from "node:fs";
import { MUX_CMD, checkHasWork, idleMarkerPath, pickPingPhrase, pingsPath, setTmuxStatus, tmuxName } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
const noStartup = process.env.CL_NO_STARTUP_PING === "1";
if (!sd || !name) emit();

// #B.149: Claude Code passes JSON on stdin including a `source` field
// matching the matcher (startup / resume / clear). On `resume`, claude
// has not actually reached the prompt yet — it's still showing the
// resume-mode picker ("context compacted or as-is?"). If we send-keys
// at that moment, the keys are typed into the picker; if we flip the
// status to `[idle]`, the bar lies about the real state. David's bug
// report: "ça passe idle avant que je choisisse le type de reprise".
// Strategy: on resume, leave the bar in `[boot]` (set by cli.ts at
// spawn) and skip the initial drain entirely — Stop hook (fires after
// the first claude turn) will flip status correctly. New SSE pings
// arriving post-picker still wake via the timer; pre-existing unread
// gets drained by the user's first prompt or the next ping.
let source = "startup";
try {
    const raw = readFileSync(0, "utf8");
    if (raw) source = (JSON.parse(raw) as { source?: string }).source ?? source;
} catch { /* no stdin, assume startup */ }

if (source === "resume") emit();

if (noStartup) {
    // Don't ping at boot, but still seed the idle state so the bar
    // doesn't carry over the cli's startup placeholder and so the
    // timer's idle-since watch starts immediately.
    try {
        writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
        setTmuxStatus(name!, "idle");
    } catch { /* swallow */ }
    emit();
}

(async () => {
    try {
        if (await checkHasWork(checkCmd)) {
            const phrase = pickPingPhrase(pingsPath(sd!));
            spawnSync(MUX_CMD, [
                "send-keys", "-t", `${tmuxName(name!)}.0`, phrase, "Enter",
            ], { stdio: "ignore" });
            setTmuxStatus(name!, "busy");
        } else {
            // Nothing to do at boot — mark idle so the timer takes
            // over the watch immediately (no need to wait for claude's
            // first Stop). Mirrors the Stop hook's "sleep" branch.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, "idle");
        }
    } catch {
        /* swallow — never block startup */
    }
    emit();
})();
