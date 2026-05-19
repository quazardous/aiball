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
import { AiballClient } from "../client.js";
import { MUX_CMD, buildContextPhrase, checkHasWork, idleMarkerPath, pingsPath, setTmuxStatus, tmuxName } from "./state.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
const noStartup = process.env.CL_NO_STARTUP_PING === "1";
if (!sd || !name) emit();

// #B.149/#B.154: Claude Code passes JSON on stdin with a `source`
// field (startup / resume / clear). On `resume`, claude shows a
// resume-mode picker before reaching the prompt. David's #B.154
// strategy: auto-dismiss the picker by sending Enter (= accept
// default, typically "resume as-is") so we don't sit in [boot]
// forever waiting for the user. Then fall through to the normal
// startup logic. Configurable resume mode (compact / abort) is a
// future follow-up via .aiball.yaml `claude_loop:` section.
let source = "startup";
try {
    const raw = readFileSync(0, "utf8");
    if (raw) source = (JSON.parse(raw) as { source?: string }).source ?? source;
} catch { /* no stdin, assume startup */ }

if (source === "resume") {
    // #B.154: auto-dismiss the resume picker — but only if it's
    // actually showing. The user might have ticked "don't ask me
    // again" in claude, in which case there's no picker and our
    // send-keys would spew garbage into the prompt.
    //
    // Mode selection (CL_RESUME_MODE env, default "as-is"):
    //   - "summary" → option 1 (recommended), just Enter
    //   - "as-is"   → option 2, Down + Enter
    //   - "abort"   → no auto-dismiss (user picks manually)
    // Future: configurable via .aiball.yaml `claude_loop:` section.
    const mode = process.env.CL_RESUME_MODE ?? "as-is";
    if (mode !== "abort") {
        try {
            // Surface what we're doing in the bar so the user can
            // follow the phase without tailing logs (#B.154).
            setTmuxStatus(name!, "boot", "resume?");
            spawnSync("sleep", ["1.2"], { stdio: "ignore" });
            const pane = spawnSync(MUX_CMD, [
                "capture-pane", "-t", `${tmuxName(name!)}.0`, "-p",
            ], { encoding: "utf8" });
            const text = pane.stdout ?? "";
            if (/Resume from summary|Resume full session as-is|Don't ask me again/.test(text)) {
                setTmuxStatus(name!, "boot", `pick→${mode}`);
                if (mode === "as-is") {
                    spawnSync(MUX_CMD, ["send-keys", "-t", `${tmuxName(name!)}.0`, "Down"], { stdio: "ignore" });
                }
                spawnSync(MUX_CMD, ["send-keys", "-t", `${tmuxName(name!)}.0`, "Enter"], { stdio: "ignore" });
            } else {
                // No picker → claude is already at the prompt, fall
                // through to the normal check + status flip below.
                setTmuxStatus(name!, "boot", "no-picker");
            }
        } catch { /* swallow */ }
    } else {
        setTmuxStatus(name!, "boot", "resume:abort");
    }
}

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
            // #B.221 david: bare cultural phrases ("Allons-y!" / "tap
            // tap") gave claude zero operational context — she would
            // greet back and burn a turn before noticing the inbox.
            // `buildContextPhrase` wraps the culture phrase with the
            // current unread/open counts + a drain directive so the
            // very first turn is oriented toward pending work.
            // Same helper now feeds stop-hook + timer fallback so the
            // wrapping is consistent across every no-hint wake path.
            const phrase = await buildContextPhrase(
                new AiballClient(),
                process.env.AIBALL_PROJECT ?? null,
                pingsPath(sd!),
            );
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
