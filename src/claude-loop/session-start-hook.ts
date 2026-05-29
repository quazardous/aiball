#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop SessionStart hook (#B.63 v2.1 + #577 boot-phase rework).
 *
 * Runs once when a claude session opens. Always emits `{}` and exits 0
 * (never block claude's boot). Two side-effects only :
 *   1. On `source: "resume"`, walk the claude --resume pickers : first
 *      the session-list (if claude has multiple recent sessions to pick
 *      from), then the summary-vs-as-is mode. Both auto-dismiss with
 *      sensible defaults, configurable per env (CL_RESUME_PICK,
 *      CL_RESUME_MODE).
 *   2. Seed the `idle-since` marker + status bar to `idle`. The timer
 *      drives every wake from here — boot phase is detected via the
 *      pane probe (`esc to interrupt` visible = still boot/busy), so a
 *      wake CAN'T fire while claude is still settling, regardless of
 *      `--wait` / `--no-wait` (#577 mg7gkf : "tant qu'on detecte esc to
 *      interrupt = phase boot").
 *
 * Previously a `--no-wait` branch would eager-inject a wake at hook
 * fire-time. That bypassed the boot detection (claude could still be
 * loading MCP servers / compacting) and is now dropped — `--no-wait`
 * now means "skip the human-takeover grace", NOT "fire immediately".
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { LOOP_STATUS, MUX_CMD, idleMarkerPath, setTmuxStatus, tmuxName } from "./state.js";
import { CL_ENV } from "./env-vars.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
if (!sd || !name) emit();
// #577 — CL_NO_STARTUP_PING / CL_WAIT no longer gate this hook's behavior :
// the hook always seeds idle and exits, the timer drives every wake. Both
// envs are kept exported by the CLI for backwards compat with `--no-startup-ping`
// / `--no-wait` flags, but the per-hook gating moved into the timer (boot
// detection + grace windows).

// Claude Code passes JSON on stdin with a `source` field (startup /
// resume / clear). On `resume`, claude may show 1 or 2 pickers before
// reaching the prompt — handled below.
let source = "startup";
try {
    const raw = readFileSync(0, "utf8");
    if (raw) source = (JSON.parse(raw) as { source?: string }).source ?? source;
} catch { /* no stdin, assume startup */ }

function capturePane(): string {
    try {
        const pane = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tmuxName(name!)}.0`, "-p",
        ], { encoding: "utf8" });
        return pane.stdout ?? "";
    } catch {
        return "";
    }
}

function sendKey(key: string): void {
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tmuxName(name!)}.0`, key], { stdio: "ignore" });
}

if (source === "resume") {
    // #577 phase 2 — session-list picker. When `claude --resume` is run
    // without a session id AND claude has multiple recent sessions, it
    // shows a list to choose from BEFORE the summary-vs-as-is mode picker.
    // Default pick: latest = send Enter on the highlighted (first = most
    // recent) entry. Override via CL_RESUME_PICK=abort (leave to human).
    //
    // Detection requires BOTH (#577 usngbr david) :
    //   - `Resume session` header → confirms WHERE we are
    //   - `Space to preview` control bar → confirms claude is awaiting input
    // Pairing both eliminates false-positives on a regular prompt that
    // happens to mention either string. The `Ctrl+A to show all projects`
    // marker tried earlier can be absent when too few sessions are listed.
    const pickMode = process.env[CL_ENV.RESUME_PICK] ?? "latest";
    let sessionPicked = false;
    if (pickMode !== "abort") {
        try {
            setTmuxStatus(name!, LOOP_STATUS.BOOT, "session?");
            spawnSync("sleep", ["1.0"], { stdio: "ignore" });
            const text = capturePane();
            if (/Resume session\b/i.test(text) && /Space to preview/i.test(text)) {
                setTmuxStatus(name!, LOOP_STATUS.BOOT, `pick:${pickMode}`);
                sendKey("Enter");
                sessionPicked = true;
            }
        } catch { /* swallow */ }
    } else {
        setTmuxStatus(name!, LOOP_STATUS.BOOT, "session:abort");
    }

    // #B.154 — summary-vs-as-is picker (always second). The user may
    // have ticked "Don't ask me again" → no picker → no-op.
    //   CL_RESUME_MODE (default "as-is"):
    //     - "summary" → option 1 (recommended), just Enter
    //     - "as-is"   → option 2, Down + Enter
    //     - "abort"   → no auto-dismiss
    //
    // #577 qbpwy9 — when we just picked a session above, claude needs
    // a few seconds to LOAD that session before showing the next picker.
    // Probe up to ~5s with 500ms granularity instead of a single fixed
    // sleep, so we catch the picker as soon as it shows AND don't waste
    // time when no picker is expected.
    const mode = process.env[CL_ENV.RESUME_MODE] ?? "as-is";
    if (mode !== "abort") {
        try {
            setTmuxStatus(name!, LOOP_STATUS.BOOT, "resume?");
            const probeMaxMs = sessionPicked ? 6000 : 1500;
            const probeStepMs = 500;
            const summaryRegex = /Resume from summary|Resume full session as-is|Don't ask me again/;
            let matched = false;
            for (let elapsed = 0; elapsed < probeMaxMs && !matched; elapsed += probeStepMs) {
                spawnSync("sleep", [String(probeStepMs / 1000)], { stdio: "ignore" });
                if (summaryRegex.test(capturePane())) {
                    matched = true;
                    setTmuxStatus(name!, LOOP_STATUS.BOOT, `pick→${mode}`);
                    if (mode === "as-is") sendKey("Down");
                    sendKey("Enter");
                }
            }
            if (!matched) setTmuxStatus(name!, LOOP_STATUS.BOOT, "no-picker");
        } catch { /* swallow */ }
    } else {
        setTmuxStatus(name!, LOOP_STATUS.BOOT, "resume:abort");
    }
}

// #577 — always seed idle + emit. Timer drives every wake. Boot phase
// (claude still loading, MCP trusts, compacting) is detected via the
// pane probe (`esc to interrupt` visible) and suppresses wakes until
// the prompt is clean. The previous `--no-wait` eager-inject branch is
// gone: it bypassed boot detection and was the source of the "wake hits
// claude mid-compact" class of bugs.
//
// `--no-wait` still has meaning : it shortens / skips the human-takeover
// grace at the timer level (BOOT_GRACE_MS path) so the loop starts
// firing as soon as the pane is clean, instead of waiting BOOT_GRACE
// extra seconds for a human to grab the keyboard.
//
// `CL_NO_STARTUP_PING` is the same end-state (idle marker + bar), kept
// as a separate flag for compatibility with `claude-loop --no-startup-ping`.
try {
    writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
    setTmuxStatus(name!, LOOP_STATUS.IDLE);
} catch { /* swallow */ }
emit();
