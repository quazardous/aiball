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
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MUX_CMD, clearResumePickers, setResumeModePicker, setResumeSessionPicker, tmuxName } from "./state.js";
import { CL_ENV } from "./env-vars.js";
import { emitHookEventToTimer } from "./hook-emit.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
if (!sd || !name) emit();

// #629 david `y43etd` : track whether the hook actually dismissed a picker.
// Only THEN do we signal boot-complete at exit — otherwise we'd write
// it prematurely when the probe timed out without matching (claude
// could still be at the picker, the user picking manually).
let sessionPicked = false;

// #577 h9axuc — log each fire so we can diagnose silent regex misses
// without a tmux-pane replay. Lives next to stop-hook.log + timer.log
// in the loop's state dir ; tail with `claude-loop tail <name>` or
// `tail -f ~/.claude-loop/<name>/session-start-hook.log`.
function log(msg: string): void {
    try {
        appendFileSync(
            join(sd!, "session-start-hook.log"),
            `${new Date().toISOString()} ${msg}\n`,
        );
    } catch { /* nowhere to log */ }
}
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

// #652 Slice 3 — emit the SessionStart event to the timer's HookService
// BEFORE the picker probe logic, so the in-process subscribers know
// immediately that a new session began. Best-effort : if the timer
// isn't up the emit silently no-ops and we fall through to the
// existing fs.marker-based flow. Top-level await ; tsx + ES2022 + NodeNext
// support it.
// #727 V1 Slice B-3 — capture the verdict so the file writes further
// down can be skipped when the timer already received the in-memory
// signal (SessionStart → setIpcBootComplete + setIpcIdleSince).
let sessionStartEmitOk = false;
if (source === "startup" || source === "resume" || source === "compact" || source === "clear") {
    try {
        sessionStartEmitOk = await emitHookEventToTimer(sd!, {
            event: "hook",
            kind: "SessionStart",
            source,
            at_ms: Date.now(),
        });
        if (sessionStartEmitOk) log(`hook-emit: SessionStart source=${source} → HookService`);
        else log(`hook-emit: SessionStart source=${source} → not reachable (timer down?)`);
    } catch (e) { log(`hook-emit: SessionStart error ${(e as Error).message ?? e}`); }
}

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
    log(`resume: pickMode=${pickMode} resumeMode=${process.env[CL_ENV.RESUME_MODE] ?? "as-is"} tmuxTarget=${tmuxName(name!)}.0`);
    if (pickMode !== "abort") {
        try {
            // #652 Slice 3 — bar paint dropped : the timer's fast-probe
            // (1s during boot) detects the picker via the same regex and
            // paints `[boot:picker:session]` via paneMarkerBarInfo. The
            // hook's own paint was the source of the #650
            // `[boot:session?]` oscillation when SessionStart fired more
            // than once per resume.
            // #577 h9axuc + hzbhxh — probe loop instead of fixed sleep : claude's
            // session-list can take 2-10s to render on a heavy MCP boot. Match
            // BOTH markers (header + control bar) so a transient half-rendered
            // pane doesn't false-positive. Bumped to 15s after david's capture
            // proved the markers ARE there but our 6s probe missed them — likely
            // the picker appears later than 6s on MCP-heavy boots.
            const probeMaxMs = 15000;
            const probeStepMs = 500;
            let matched = false;
            let firstCaptureLen = -1;
            let lastCaptureLen = -1;
            for (let elapsed = 0; elapsed < probeMaxMs && !matched; elapsed += probeStepMs) {
                spawnSync("sleep", [String(probeStepMs / 1000)], { stdio: "ignore" });
                const text = capturePane();
                if (firstCaptureLen === -1) firstCaptureLen = text.length;
                lastCaptureLen = text.length;
                if (/Resume session\b/i.test(text) && /Space to preview/i.test(text)) {
                    matched = true;
                    log(`session-picker: matched at ${elapsed + probeStepMs}ms (paneLen=${text.length}) → pick:${pickMode} (Enter)`);
                    // #647 Slice 2 david `sr9kqw` : marker spécifique
                    // session-picker (1er écran resume). #624 originel.
                    setResumeSessionPicker(sd!, true);
                    // #727 V1 Slice B-2 — also push the picker state to
                    // the timer's in-memory IpcState via a fresh
                    // SessionStart event carrying the flag. Subscriber
                    // pins it on `IpcState.resumeSessionPickerActive`.
                    void emitHookEventToTimer(sd!, {
                        event: "hook",
                        kind: "SessionStart",
                        source,
                        at_ms: Date.now(),
                        picker_session: true,
                    });
                    // #652 Slice 3 — bar paint dropped, timer fast-probe
                    // owns it (see paneMarkerBarInfo).
                    sendKey("Enter");
                    sessionPicked = true;
                }
            }
            if (!matched) log(`session-picker: no match in ${probeMaxMs}ms (firstCaptureLen=${firstCaptureLen} lastCaptureLen=${lastCaptureLen})`);
        } catch (e) { log(`session-picker: error ${(e as Error).message ?? e}`); }
    } else {
        log(`session-picker: skipped (CL_RESUME_PICK=abort)`);
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
            // #652 Slice 3 — bar paint dropped (timer fast-probe owns it).
            const probeMaxMs = sessionPicked ? 6000 : 1500;
            const probeStepMs = 500;
            const summaryRegex = /Resume from summary|Resume full session as-is|Don't ask me again/;
            let matched = false;
            for (let elapsed = 0; elapsed < probeMaxMs && !matched; elapsed += probeStepMs) {
                spawnSync("sleep", [String(probeStepMs / 1000)], { stdio: "ignore" });
                if (summaryRegex.test(capturePane())) {
                    matched = true;
                    log(`summary-picker: matched at ${elapsed + probeStepMs}ms → pick→${mode}`);
                    // #647 Slice 2 david `sr9kqw` : marker spécifique
                    // mode-picker (2e écran resume : summary vs as-is).
                    setResumeModePicker(sd!, true);
                    // #727 V1 Slice B-2 — mirror to timer's IpcState.
                    void emitHookEventToTimer(sd!, {
                        event: "hook",
                        kind: "SessionStart",
                        source,
                        at_ms: Date.now(),
                        picker_mode: true,
                    });
                    // #652 Slice 3 — bar paint dropped (timer fast-probe owns it).
                    if (mode === "as-is") sendKey("Down");
                    sendKey("Enter");
                }
            }
            if (!matched) {
                log(`summary-picker: no match in ${probeMaxMs}ms`);
            }
        } catch (e) { log(`summary-picker: error ${(e as Error).message ?? e}`); }
    } else {
        log(`summary-picker: skipped (CL_RESUME_MODE=abort)`);
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
    // #793 — idle-since lives in the bus. The early SessionStart
    // emitHookEventToTimer above already seeded it via the HookService
    // subscriber; the file is gone. If the emit failed, the bar simply
    // shows boot until the next pane-probe → claude-at-prompt detection.
    // #629 david `y43etd` : ne write `boot-complete` QUE si on a vraiment
    // dismissé un picker (auto-pick a fire) OU si on est sous --resume
    // abort (= user demande pas d'aide). Sinon (probe picker n'a pas
    // matché dans 15s — pourrait être pas de picker du tout OU picker
    // qui tarde) on LAISSE l'état des markers tel quel : le timer's
    // pane probe verra `paneReady=true` une fois claude vraiment prompt,
    // ce qui sortira de boot via la règle paneReady (à venir #629).
    // Pour l'instant : le time cap (300s) reste fail-safe.
    // #629 david `y43etd` : decide whether the hook is confident enough
    // to signal boot-complete :
    //   - source !== "resume"   → no picker expected, claude is direct
    //     at the prompt. Safe to signal.
    //   - sessionPicked === true → auto-pick fired Enter, claude is past
    //     the picker. Safe to signal.
    //   - else (probe didn't match, --resume + pickMode=abort, slow boot)
    //     → DON'T signal. Bar stays [boot] until the timer's pane probe
    //     sees the prompt OR the safety cap fires.
    const sessionPickerAborted = (process.env[CL_ENV.RESUME_PICK] ?? "latest") === "abort";
    const safeToSignal = source !== "resume" || sessionPicked || sessionPickerAborted;
    if (safeToSignal) {
        clearResumePickers(sd!);
        // #727 V1 Slice B-2 — also clear the in-memory picker flags so
        // the wake gate doesn't see a stale "still in resume picker"
        // state after the timer's HookService subscriber pushed `true`
        // earlier in this hook.
        void emitHookEventToTimer(sd!, {
            event: "hook",
            kind: "SessionStart",
            source,
            at_ms: Date.now(),
            picker_session: false,
            picker_mode: false,
        });
        // #652 Slice 3 — bar IDLE paint dropped. The timer's
        // bus.bootEnded handler in timer.ts already calls
        // setTmuxStatus(IDLE) when boot phase settles, so the hook's
        // paint was redundant ; removing it kills the last remaining
        // bar-paint site in this hook (the #650 oscillation root).
        log(`seed idle + signal boot-complete (source=${source} sessionPicked=${sessionPicked} aborted=${sessionPickerAborted}) + exit`);
    } else {
        log(`seed idle (probe didn't match picker, boot-complete NOT signalled — bar stays [boot] until pane probe sees prompt or safety cap fires) + exit (source=${source})`);
    }
} catch { /* swallow */ }
emit();
