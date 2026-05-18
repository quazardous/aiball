#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop timer process (#B.63 TS port, #B.148 phase C reactive).
 *
 * Detached child of the `start` command. Two operating modes:
 *
 *   - **SSE mode** (when CL_CHECK_CMD is the default aiball check):
 *     opens a long-lived SSE stream to the daemon's `/api/events`
 *     endpoint and wakes claude as soon as a `ping` event arrives. No
 *     polling lag. A slow heartbeat (every CL_INTERVAL) checks
 *     `wake-requested` and re-verifies in case SSE silently dropped.
 *
 *   - **Polling mode** (custom CL_CHECK_CMD or when SSE refuses to
 *     start): legacy `while(sleep, check)` loop — exact behavior
 *     pre-#B.148.
 *
 * Both modes share `tryWake()` which honors idle-since + user-grace +
 * tmux-alive gates, fires send-keys, and updates the tmux status bar.
 *
 * Logs to stdout (the launcher redirects to $STATE_DIR/timer.log).
 * Exits when the tmux session disappears.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AiballClient } from "../client.js";
import {
    isInternalCheckCmd,
    DEFAULT_USER_GRACE_SEC,
    MUX_CMD,
    checkHasWork,
    idleMarkerPath,
    paneFooterShowsBusy,
    pickPingPhrase,
    pingsPath,
    setTmuxStatus,
    tmuxName,
    userIsTakingOver,
    wakeInFlightPath,
    wakeRequestedPath,
} from "./state.js";

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const intervalRaw = process.env.CL_INTERVAL;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
const userGraceSec = Math.max(0, Number(process.env.CL_USER_GRACE_SEC ?? DEFAULT_USER_GRACE_SEC));
if (!sd || !name || !intervalRaw) {
    process.stderr.write("[claude-loop:timer] missing CL_* env vars\n");
    process.exit(1);
}
const interval = Math.max(1, Number(intervalRaw));
const tname = tmuxName(name);

function log(msg: string): void {
    process.stdout.write(`[claude-loop:${name}] ${msg}\n`);
}

function tmuxAlive(): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tname], { stdio: "ignore" });
    return r.status === 0;
}

/**
 * Read the visible content of pane 0. Empty string on any failure
 * (tmux gone, capture errored) — callers fall back to last-known
 * state. Used by the heartbeat `esc to interrupt` probe (#B.173).
 */
function capturePane(): string {
    try {
        const r = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tname}.0`, "-p",
        ], { encoding: "utf8" });
        return r.stdout ?? "";
    } catch {
        return "";
    }
}

function pickPhrase(): string {
    return pickPingPhrase(pingsPath(sd!));
}

function sendKeys(phrase: string): void {
    // #B.180: touch the wake-in-flight marker BEFORE send-keys so
    // UserPromptSubmit hook sees it when claude processes the wake
    // prompt and skips the user-took-over update. Without this, the
    // auto-wake would trigger the user-grace and lock subsequent
    // wakes for `CL_USER_GRACE_SEC` (default 300s).
    try {
        writeFileSync(wakeInFlightPath(sd!), new Date().toISOString() + "\n");
    } catch { /* ignore — UserPromptSubmit hook will fall through to user-grace path, suboptimal but safe */ }
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, phrase, "Enter"], { stdio: "ignore" });
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// Cached client for the default-path direct API call (no fork). The
// process is long-lived so the keep-alive socket / token resolution
// stays warm across ticks. Passed into the shared `checkHasWork`
// helper (state.ts) so the keep-alive socket stays warm; the helper
// itself centralizes the empty/default/custom branching (#B.141).
let aiballClient: AiballClient | null = null;
function client(): AiballClient {
    if (!aiballClient) aiballClient = new AiballClient();
    return aiballClient;
}

/**
 * Common wake path used by SSE-driven and timer-driven modes. Honors
 * all the gates (idle-since, user-grace, optional check-cmd) and only
 * actually fires send-keys when claude is at the prompt with work to
 * do. Returns true iff a wake was sent — useful for logging.
 *
 * `manualWake = true` (file-marker bypass) skips the user-grace AND
 * the check-cmd; only the idle-since gate stays because pinging over
 * a busy claude is always wrong.
 */
async function tryWake(reason: string, manualWake = false): Promise<boolean> {
    if (!existsSync(idleMarkerPath(sd!))) return false;
    if (!manualWake && userIsTakingOver(sd!, userGraceSec)) return false;
    if (!manualWake && !(await checkHasWork(checkCmd, client()))) return false;
    try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
    try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    const phrase = pickPhrase();
    sendKeys(phrase);
    setTmuxStatus(name!, "busy");
    log(`wake (${reason}) → '${phrase}'`);
    return true;
}

/**
 * SSE-driven main loop (#B.148 phase C). Subscribes once, lets the
 * daemon push `ping` events, and reacts via `tryWake`. Parallel slow
 * heartbeat handles two things SSE can't:
 *   - `wake-requested` file marker (claude-loop wake NAME)
 *   - SSE-drop safety net (re-verifies via checkHasWork in case the
 *     stream silently dropped under load)
 *
 * On SSE error, the heartbeat keeps running; next iteration re-opens
 * the stream with simple backoff (no aggressive reconnect storm).
 */
async function mainSse(): Promise<void> {
    log(`timer started — SSE mode (heartbeat ${interval}s), check-cmd: ${checkCmd || "(internal SDK)"}`);
    let unsubscribe: (() => void) | null = null;
    let lastConnectAt = 0;
    const reconnect = () => {
        // Throttle reconnects (one per 5s) so a daemon flap doesn't
        // turn into a hot loop.
        const now = Date.now();
        if (now - lastConnectAt < 5000) return;
        lastConnectAt = now;
        unsubscribe?.();
        unsubscribe = client().subscribeEvents({
            onHello: (h) => { log(`SSE hello: unread=${h.unread}`); },
            onPing: (p) => {
                log(`SSE ping received: ${JSON.stringify(p)} → tryWake`);
                void tryWake("sse:ping");
            },
            onError: (e) => {
                log(`SSE error: ${e.message ?? String(e)} — will reconnect on next heartbeat`);
                unsubscribe = null;
            },
        });
        log("SSE subscribed");
    };
    reconnect();
    // #B.148 bug: SSE only fires on NEW pings — existing unread at
    // boot would never trigger a wake until a fresh ping arrives.
    // Immediate tryWake covers the case where pings already exist
    // when the loop spawns (e.g. claude --resume scenario, or a
    // crashed-and-restarted loop).
    await tryWake("startup");
    // #B.149: post-boot heuristic. Claude Code has no native "claude
    // is at prompt" signal — for `--resume` the SessionStart hook
    // fires BEFORE the user dismisses the picker, so we can't flip
    // status there. After BOOT_GRACE_MS the timer assumes claude has
    // settled, seeds the idle marker, and lets tryWake run normally
    // (will wake if SSE has been silent but there's actually work).
    // David: "on passe en idle avec un timeout court (60 sec par
    // defaut), si le user fait pas de prompt on lance l'auto ping,
    // si le user prompt on passe dasn la hook stop plus tard". User
    // input within the window updates user-took-over → tryWake's
    // user-grace gate skips the wake (the user is actively driving).
    // #B.180: yaml-configurable via `.aiball.yaml claude_loop.boot_grace_seconds`.
    // Env-var override read here at boot; cli.ts writes the resolved value.
    const BOOT_GRACE_MS = Math.max(0, Number(process.env.CL_BOOT_GRACE_SEC ?? 60)) * 1000;
    let bootSettled = false;
    const settleBoot = async () => {
        if (bootSettled) return;
        bootSettled = true;
        log("boot grace elapsed — settling to idle/busy via check");
        // Seed idle-since so tryWake's gate passes; tryWake will
        // flip to busy if there's work or stay idle otherwise.
        try {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
        } catch { /* ignore */ }
        await tryWake("boot-settle");
        // tryWake removes idle-since on wake; if it didn't fire,
        // we still want the bar to read [idle] not [boot].
        if (existsSync(idleMarkerPath(sd!))) {
            setTmuxStatus(name!, "idle");
        }
    };
    setTimeout(() => { void settleBoot(); }, BOOT_GRACE_MS);
    // #B.149: track the "settled" status so the count-refresh below
    // doesn't reset bar to idle while claude is busy. tryWake flips
    // to busy on wake; we mirror that. Boot stays until settleBoot.
    // #B.173 (david skybot bug): heartbeat pane-probe flips between
    // `busy` and `idle` based on `esc to interrupt`, covering slash
    // commands (/compact, /clear) that don't fire Stop hook.
    let settledStatus: "boot" | "idle" | "busy" = "boot";
    while (tmuxAlive()) {
        await sleep(interval * 1000);
        // Manual wake (claude-loop wake NAME): file marker, fires
        // even when SSE silent.
        if (existsSync(wakeRequestedPath(sd!))) {
            await tryWake("manual", true);
            settledStatus = "busy";
            continue;
        }
        // SSE-drop safety net: re-check the gate ourselves.
        if (!unsubscribe) reconnect();
        const woke = await tryWake("heartbeat");
        if (woke) settledStatus = "busy";
        else if (existsSync(idleMarkerPath(sd!))) settledStatus = "idle";
        // Pane-probe (#B.173, refined #B.154 davids). `esc to
        // interrupt` is THE authoritative claude-busy signal
        // ("seul le esc to interrupt est vraiment crucial dans le
        // workflow"). Heartbeat flips the bar between `busy` and
        // `idle` independently of hook events, covering slash
        // commands (/compact, /clear) that don't fire Stop hook.
        //
        // Runs from the FIRST heartbeat (no boot gate). The prompt-
        // signature check ("Claude Code v" header or "❯"/"> ") guards
        // against flipping to idle while claude is still spawning the
        // splash — without it, an early empty pane would seed
        // idle-since and the next tick would ping over a still-
        // loading claude. When the pane settles, the probe overrides
        // boot grace so we don't wait BOOT_GRACE_MS for nothing.
        //
        // For "state pas claire" (pane empty, garbled, no prompt
        // signature, no esc-to-interrupt): stay last-state.
        // Conservative — pinging into uncertainty is the costly
        // mistake; over-displaying busy is the cheap one.
        //
        // Alternatives considered and DISCARDED (#B.172, david's hint
        // "le reste devrait servir à décorer (hint)") — kept here as
        // a written record so a future reader doesn't re-litigate:
        //   - Re-arm differé après transient state (detect compacting/
        //     rate-limit/api-error cleared after T+30s): decoration,
        //     not workflow-critical.
        //   - Read claude-code's JSONL transcript at ~/.claude/
        //     projects/<hash>/<id>.jsonl for authoritative turn
        //     boundaries: heavier, and `esc to interrupt` covers the
        //     only critical case.
        //   - PostToolUse / PreToolUse hooks to differentiate
        //     busy:tool-use vs busy:thinking: pure decoration.
        //   - tmux pane-title / cursor-position events: claimed less
        //     fragile but requires custom tmux pipe-pane wiring; no
        //     concrete payoff over capture-pane regex.
        // If a future need shows real value, open a fresh ticket.
        const paneText = capturePane();
        if (paneText) {
            const claudeWorking = paneFooterShowsBusy(paneText);
            const claudeReady = /Claude Code v|❯ |^> /m.test(paneText);
            if (claudeWorking && settledStatus !== "busy") {
                settledStatus = "busy";
                bootSettled = true; // probe overrides boot grace
            } else if (claudeReady && !claudeWorking && settledStatus !== "idle") {
                // Claude is at the prompt. Seed idle-since so the
                // next tryWake has a clean gate and flip the bar.
                settledStatus = "idle";
                bootSettled = true;
                try {
                    const { writeFileSync } = await import("node:fs");
                    writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
                } catch { /* ignore */ }
            }
            // Else: pane present but ambiguous → keep settledStatus.
        }
        // Refresh the bar with the current unread count (#B.149
        // david: "dans la barre mux on peut afficher le nombre de
        // read / ticket meme en idle ?"). Skipped while booting —
        // count is meaningless until settleBoot or the probe
        // detected claude is ready (whichever comes first).
        if (settledStatus !== "boot") {
            try {
                const r = await client().pingsCount() as { unread?: number };
                setTmuxStatus(name!, settledStatus, r.unread ?? 0);
            } catch { /* swallow — bar stays as-is */ }
        }
        // #B.177 B1: heartbeat push of current state to the daemon
        // so the consumers panel shows `[busy]`/`[idle]`/`[boot]` per
        // agent + an "offline" badge after 60s without a push.
        // Fire on EVERY tick (not just transitions) — the daemon
        // updates `state_updated_at` always, freshness signal for
        // the UI's offline detector.
        try {
            await client().pushState(settledStatus);
        } catch { /* daemon down or transient — next tick retries */ }
    }
    log("tmux session gone — timer exiting");
    if (unsubscribe) (unsubscribe as () => void)();
}

/**
 * Pre-#B.148 polling loop, kept for non-aiball check-cmds where SSE
 * doesn't apply.
 */
async function mainPoll(): Promise<void> {
    log(`timer started — polling mode (tick ${interval}s), check-cmd: ${checkCmd}`);
    // Same startup safety net as SSE mode (#B.148): drain any
    // pre-existing work right away instead of waiting `interval`s.
    await tryWake("startup");
    while (tmuxAlive()) {
        await sleep(interval * 1000);
        const manualWake = existsSync(wakeRequestedPath(sd!));
        await tryWake(manualWake ? "manual" : "check-cmd hit", manualWake);
    }
    log("tmux session gone — timer exiting");
}

async function main(): Promise<void> {
    if (isInternalCheckCmd(checkCmd)) {
        await mainSse();
    } else {
        await mainPoll();
    }
}

main().catch((e) => {
    process.stderr.write(`[claude-loop:${name}] timer crashed: ${String(e)}\n`);
    process.exit(1);
});
