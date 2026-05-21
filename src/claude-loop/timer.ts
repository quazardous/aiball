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
import { existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import {
    isInternalCheckCmd,
    DEFAULT_USER_GRACE_SEC,
    MUX_CMD,
    WAKE_COALESCE_WINDOW_MS,
    buildContextPhrase,
    buildWakePhrase,
    injectWakePhrase,
    checkHasWork,
    formatPaneSnapshot,
    idleMarkerPath,
    humanTypingPath,
    humanIsTyping,
    injectSockPath,
    installRoot,
    installRootSha,
    isLoopStale,
    isDuplicateWakeHint,
    lastWakeAtPath,
    paneFooterShowsBusy,
    pingsPath,
    readBusyDefer,
    readLastOpenWakeCount,
    recordOpenWakeCount,
    recordWakeHint,
    setTmuxStatus,
    snapshotPane,
    tmuxName,
    userIsTakingOver,
    wakeInFlightPath,
    wakeRequestedPath,
    readPlate,
    writePlate,
    envPath,
    timerLogPath,
    timerPidPath,
    type Plate,
    type WakeHint,
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
    // #B.198 david: timer lines were missing timestamps — added at
    // the head to match stop-hook.log and to let `--log` reorder as
    // `<ts> [tag] body`.
    process.stdout.write(`${new Date().toISOString()} [claude-loop:${name}] ${msg}\n`);
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

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * #251: self-reload on stale source. Called from the heartbeat ONLY when
 * claude is idle with nothing to wake on — the safe lull david asked for
 * ("il faut le faire que quand claude-loop passe en idle, cad rien à
 * faire"). If the install root's git SHA has moved since this timer
 * booted, re-exec a fresh timer in place: the tmux session + claude pane
 * are untouched (the conversation survives), only the long-lived timer
 * process — which holds stale code in memory since tsx doesn't hot-reload
 * (#B.198) — is recycled.
 *
 * Re-stamps `plate.started_at_sha` to the current HEAD BEFORE respawning
 * so the fresh timer boots in-sync and doesn't immediately reload again.
 * That restamp is also the natural debounce against a burst of commits:
 * each reload jumps straight to the latest SHA. No-ops on non-git installs
 * (`isLoopStale` is false when `installRootSha` can't resolve), leaving
 * binary deployments on manual `claude-loop reload`.
 *
 * Does not return when it reloads — the process exits after handing off.
 */
function selfReloadIfStale(): void {
    let plate: Plate;
    try { plate = readPlate(sd!); } catch { return; }
    if (!isLoopStale(plate)) return;
    const sha = installRootSha();
    log(
        `source moved since boot (${(plate.started_at_sha ?? "?").slice(0, 7)} → ${(sha ?? "?").slice(0, 7)}) ` +
        `and loop is idle — self-reloading timer`,
    );
    if (sha) {
        plate.started_at_sha = sha;
        try { writePlate(sd!, plate); } catch { /* best effort — fresh timer would just reload once more */ }
    }
    const root = installRoot();
    const logFd = openSync(timerLogPath(sd!), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    const tsxBin = shQuote(join(root, "node_modules", ".bin", "tsx"));
    const child = spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd!))} && exec ${tsxBin} ${shQuote(timerScript)}`,
    ], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    writeFileSync(timerPidPath(sd!), String(child.pid) + "\n");
    log(`timer respawned — new pid ${child.pid}, exiting old`);
    process.exit(0);
}

// #B.221: when the SSE hint carries a ticket_id, `buildWakePhrase`
// renders the directive template ("Handle ticket #X — comment #Y.")
// — already context-rich, no wrap needed. When there's no hint
// (heartbeat re-check, manual wake, SSE-drop safety net), we used to
// fall back to a bare culture phrase from `pickPingPhrase`. That left
// claude with the same no-context greeting bug session-start had.
// Now we route the no-hint path through `buildContextPhrase` so the
// wake carries unread/open counts + a drain directive too. Async
// because the wrap helper queries the daemon; tryWakeInner already
// awaits checkHasWork so adding another await here is a no-op.
async function pickPhrase(hint?: WakeHint): Promise<string> {
    if (hint?.ticket_id) return buildWakePhrase(hint, pingsPath(sd!));
    return buildContextPhrase(
        client(),
        process.env.AIBALL_PROJECT ?? null,
        pingsPath(sd!),
    );
}

/**
 * Panic-interrupt path (#B.214). Triggered when an SSE ping arrives
 * with `intent === "panic"`. Unlike `tryWake`, this DOES NOT honor
 * any of the usual gates — busy-defer, capture-pane probe,
 * user-grace, and checkHasWork are all skipped. The human posted
 * a panic ticket precisely because they want claude interrupted
 * mid-turn, however busy claude appears to be.
 *
 * No rate-limit, no humans-only gate — david (#w47f9m):
 * "non (mais c'est pas un mécanisme qui doit etre plebicité)".
 * Moderation already gates message creation; double-gating here
 * would mostly trip legitimate cases. Comments on panic tickets
 * inherit the same path via SSE — there's no comment-level panic
 * because the UI doesn't surface it (david: "dans l'ui j'ai pas
 * le panic pour les commente . donc evoque le en commentaire dans
 * le code mais ticket only").
 *
 * Flow:
 *   1. Fetch the ticket body via the daemon — the SSE payload only
 *      carries ids, but the "complete message" david asked for is
 *      the body itself, formatted for visual urgency on the pane.
 *   2. Send double-Escape — Claude Code's interrupt-this-turn chord.
 *   3. Wait ~500ms for the prompt to repaint.
 *   4. Paste the wrapped body via a tmux paste-buffer (preserves
 *      newlines without the per-line Enter that `send-keys` would
 *      otherwise submit-on-first-newline). Fallback: single-line
 *      `send-keys` if `set-buffer` errored.
 *   5. Send Enter to submit.
 */
async function tryPanic(reason: string, hint: WakeHint): Promise<boolean> {
    if (!hint.ticket_id) {
        log(`skip panic (${reason}) — no ticket_id in hint`);
        return false;
    }
    let title = "";
    let body = "";
    let author = "(unknown)";
    try {
        const resp = await client().getTicket(hint.ticket_id, { summary: false }) as {
            ticket?: { title?: string | null; body?: string | null; by_agent?: string | null };
        };
        title = resp?.ticket?.title ?? "";
        body = resp?.ticket?.body ?? "";
        author = resp?.ticket?.by_agent ?? "(unknown)";
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        log(`panic (${reason}) — getTicket failed: ${m} — interrupting with ref only`);
    }
    const MAX_BODY = 4000;
    const trunc = body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "…[truncated]" : body;
    const msg = `PANIC: ${author} interrupted you on ticket #B.${hint.ticket_id} "${title}"\n\n${trunc}\n\nPoll #B.${hint.ticket_id} for the full thread.`;
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, "Escape", "Escape"], { stdio: "ignore" });
    await sleep(500);
    const bufName = `panic_${Date.now()}`;
    const setBuf = spawnSync(MUX_CMD, ["set-buffer", "-b", bufName, msg], { stdio: "ignore" });
    if (setBuf.status === 0) {
        spawnSync(MUX_CMD, ["paste-buffer", "-b", bufName, "-d", "-t", `${tname}.0`], { stdio: "ignore" });
    } else {
        const oneLine = msg.replace(/\n+/g, " ");
        spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, oneLine], { stdio: "ignore" });
    }
    await sleep(200);
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, "Enter"], { stdio: "ignore" });
    setTmuxStatus(name!, "busy");
    log(`panic (${reason}) → interrupted + injected body (${msg.length} chars) for ticket #B.${hint.ticket_id} by ${author}`);
    return true;
}

// #264: timestamp of the loop's last send-keys, so the human-typing
// detector can exclude the loop's own injected text from "a human typed".
let lastSendAt = 0;
async function sendKeys(phrase: string): Promise<void> {
    // #B.180: touch the wake-in-flight marker BEFORE send-keys so
    // UserPromptSubmit hook sees it when claude processes the wake
    // prompt and skips the user-took-over update. Without this, the
    // auto-wake would trigger the user-grace and lock subsequent
    // wakes for `CL_USER_GRACE_SEC` (default 300s).
    try {
        writeFileSync(wakeInFlightPath(sd!), new Date().toISOString() + "\n");
    } catch { /* ignore — UserPromptSubmit hook will fall through to user-grace path, suboptimal but safe */ }
    // #B.198 fix A: shared coalesce marker — Stop hook reads it to
    // suppress chain-fire bursts. Touched here so timer-driven
    // wakes also count toward the coalesce window.
    try {
        writeFileSync(lastWakeAtPath(sd!), new Date().toISOString() + "\n");
    } catch { /* ignore — coalesce will just fail open */ }
    lastSendAt = Date.now();
    await injectWakePhrase(`${tname}.0`, phrase);
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// #264 (david #c5fgha "ok B"): near-live detection of a human typing in
// the pane, via pane-diff. While claude is AT THE PROMPT (idle marker
// present = not mid-turn, no output streaming), poll the bottom of the
// pane; if it changes and the loop didn't just send-keys, a human is
// typing → refresh the human-typing marker (drives the bicolor bar chip
// in setTmuxStatus, and is a finer human-present signal than the
// submit-time user-took-over). Fail-safe: never throws — it must not
// disturb the wake loop. NOTE: only reliable at the prompt; detecting
// typing WHILE claude streams is out of scope for pane-diff.
const HUMAN_POLL_MS = 1500;
let prevPaneTail = "";
let humanChipShown = false;
function recentlySentKeys(): boolean {
    return Date.now() - lastSendAt < 3000;
}
function detectHumanTyping(): void {
    try {
        // #269: when the PTY proxy fronts claude it feeds the human-typing
        // marker directly (live, busy included) and wake injection bypasses
        // tmux stdin — so this pane-diff heuristic is both redundant AND
        // wrong here (it would flag socket-injected wakes as human typing,
        // since recentlySentKeys only tracks tmux send-keys). The proxy owns
        // the marker; skip. Pane-diff stays the fallback for non-proxy loops.
        if (existsSync(injectSockPath(sd!))) return;
        if (!existsSync(idleMarkerPath(sd!))) {
            // Mid-turn / streaming → reset baseline so the post-busy
            // prompt isn't diffed against a stale pre-busy capture.
            prevPaneTail = "";
            return;
        }
        const pane = capturePane();
        if (!pane) return;
        const tail = pane
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0)
            .slice(-4)
            .join("\n");
        if (prevPaneTail && tail !== prevPaneTail && !recentlySentKeys()) {
            try {
                writeFileSync(humanTypingPath(sd!), new Date().toISOString() + "\n");
            } catch { /* ignore — chip just won't show */ }
            log("human-typing detected (prompt area changed at idle)");
        }
        prevPaneTail = tail;
        // Edge-repaint the bicolor chip when it appears / clears (the
        // marker expires ~HUMAN_TYPING_TTL_SEC after the last keystroke).
        const showing = humanIsTyping(sd!);
        if (showing !== humanChipShown) {
            setTmuxStatus(name!, "idle");
            humanChipShown = showing;
        }
    } catch { /* never throw from the detection poll */ }
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
// #B.205 david: "tous les event joue avec la meme balle (...) on
// donne le premier les autre viendront plus tard au hook suivant".
// In-flight mutex: when N SSE pings for DIFFERENT comments arrive in a
// burst, all tryWake calls used to pass the synchronous gates and
// queue at the `await checkHasWork` line — then all fired send-keys
// once the network call returned, pasting N phrases. With the mutex,
// only the first wake proceeds; concurrent attempts drop. The Stop
// hook (or next heartbeat) sees pings still unread post-turn and
// fires the next wake. Same ball, one at a time.
let tryWakeInFlight: Promise<boolean> | null = null;
async function tryWake(reason: string, manualWake = false, hint?: WakeHint): Promise<boolean> {
    if (tryWakeInFlight) {
        log(`skip wake (${reason}) — coalesce: another wake in flight`);
        return false;
    }
    tryWakeInFlight = tryWakeInner(reason, manualWake, hint).finally(() => {
        tryWakeInFlight = null;
    });
    return tryWakeInFlight;
}
async function tryWakeInner(reason: string, manualWake: boolean, hint?: WakeHint): Promise<boolean> {
    // #B.211 david: previously these two gates returned silently. The
    // log only showed `SSE ping received: ... → tryWake` and then
    // nothing for the same reason — david couldn't tell if the wake
    // was deferred, skipped, or actually fired. Log every skip with
    // a short reason so the log is self-explaining.
    if (!existsSync(idleMarkerPath(sd!))) {
        log(`skip wake (${reason}) — no idle marker (claude is busy or boot grace not yet elapsed)`);
        return false;
    }
    if (!manualWake && userIsTakingOver(sd!, userGraceSec)) {
        log(`skip wake (${reason}) — user-grace active (user typed within ${userGraceSec}s)`);
        return false;
    }
    // #B.198 david: state-based busy defer set by the Stop hook when
    // the FIRE-time pane still showed `esc to interrupt`. We honor
    // it on every tryWake path EXCEPT manual (file-marker is an
    // explicit user override). Marker auto-clears once its target
    // ISO is past (handled inside `readBusyDefer`).
    if (!manualWake) {
        const defer = readBusyDefer(sd!);
        if (defer) {
            log(`skip wake (${reason}) — busy-defer ${defer.activeMs}ms remaining (until ${defer.until.toISOString()})`);
            return false;
        }
    }
    // #B.198: catch the brief race where the idle marker has been
    // written (Stop hook just fired) but claude is still mid-turn
    // (a slash command, a hook in flight, or just hasn't repainted
    // the prompt). Without this probe, a fast SSE ping landing in
    // that window pastes a wake phrase on top of visible output —
    // david: "même si claude est busy il se fait pop culture pingué".
    // Skip the probe for manual wakes (file-marker bypass) since
    // those are explicit user requests.
    if (!manualWake) {
        const paneText = capturePane();
        if (paneText) {
            const snap = snapshotPane(paneText);
            // Both `busy` (esc-to-interrupt mid-turn) and any `special`
            // state (compacting/rate-limit/api-error) are reasons to
            // skip — same family of "claude is internally busy". Log
            // the snapshot so david sees why a wake was withheld
            // (#B.198 david: "ajoute la detection esc to interrupt
            // dans les log").
            if (snap.busy || snap.special !== null) {
                log(`skip wake (${reason}) — ${formatPaneSnapshot(snap)}`);
                return false;
            }
        }
    }
    let gateOpenCount = 0;
    if (!manualWake) {
        const gate = await checkHasWork(
            checkCmd,
            client(),
            process.env.AIBALL_PROJECT ?? null,
            sd!,
        );
        if (!gate.has) {
            const watermark = readLastOpenWakeCount(sd!);
            log(`skip wake (${reason}) — checkHasWork returned false (pings=${gate.pingsCount} open=${gate.openCount} watermark=${watermark})`);
            return false;
        }
        gateOpenCount = gate.openCount;
    }
    try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
    try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    const phrase = await pickPhrase(hint);
    await sendKeys(phrase);
    // #B.198 david: "on cumule pas les event identique on les merge".
    // Persist the just-fired hint so subsequent SSE pings about the
    // same (ticket, comment) within `WAKE_COALESCE_WINDOW_MS` get
    // dropped at `onPing` (event-layer merge, no DB write).
    recordWakeHint(sd!, hint);
    // #B.232 ch887f: bump the open-tickets watermark so the same N
    // tickets don't re-fire the gate on every heartbeat. Only when
    // we observed the count via the SDK path (manual/legacy wakes
    // leave gateOpenCount=0 → watermark drops, which is fine).
    if (gateOpenCount > 0) recordOpenWakeCount(sd!, gateOpenCount);
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
    // #B.225: log the install-root SHA so `--log` shows what version
    // of the timer is actually running. `cmdList` / `cmdCheck` diff
    // this against the live HEAD to flag a ghost daemon.
    const bootSha = installRootSha();
    if (bootSha) log(`timer source: install-root SHA ${bootSha.slice(0, 7)}`);
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
                // #B.214: panic intent → interrupt-this-turn path,
                // bypasses every gate. Routed FIRST so the dup-hint
                // coalesce below doesn't swallow a panic that
                // happens to share a (ticket, comment) tuple with a
                // recent normal wake. Rate-limit lives inside
                // tryPanic itself (1/min floor).
                if (p.intent === "panic") {
                    log(`SSE ping received: ${JSON.stringify(p)} → tryPanic`);
                    void tryPanic("sse:ping:panic", p);
                    return;
                }
                // #B.198 david: "on cumule pas les event identique on
                // les merge". When N SSE pings about the same
                // (ticket, comment) arrive in a burst, only the first
                // gets a wake; the rest are dropped here at the event
                // boundary. Hook layer only — model is untouched.
                if (isDuplicateWakeHint(sd!, p, WAKE_COALESCE_WINDOW_MS)) {
                    log(`SSE ping coalesced (dup hint <${WAKE_COALESCE_WINDOW_MS}ms): ${JSON.stringify(p)}`);
                    return;
                }
                log(`SSE ping received: ${JSON.stringify(p)} → tryWake`);
                // #B.198 david: pass the SSE payload as a hint so the
                // wake phrase names the concrete artifact ("Poll ticket
                // #X — new comment #Y.") instead of a random pop-culture
                // line, which left claude guessing what to do.
                void tryWake("sse:ping", false, p);
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
        if (bootSettled) {
            // #B.228: surface the skip so we know the pane probe
            // already flipped bootSettled — otherwise the log goes
            // dark at T+60s and it looks like settleBoot vanished.
            log("settleBoot skipped — bootSettled already true (probe flipped earlier)");
            return;
        }
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
            // #B.228: log the bar flip so "barre reste jaune" repros
            // surface either this line (it WAS flipped) or its
            // absence (settleBoot didn't reach the idle-marker check).
            log("settleBoot: idle-marker present → setTmuxStatus(idle)");
            setTmuxStatus(name!, "idle");
        } else {
            log("settleBoot: idle-marker missing after tryWake (wake fired?) — bar stays as set by wake path");
        }
    };
    setTimeout(() => { void settleBoot(); }, BOOT_GRACE_MS);
    // #264: near-live human-typing detection poll (bicolor bar chip).
    // Independent of the wake heartbeat — fast cadence so the chip
    // tracks typing closely. Fail-safe (detectHumanTyping never throws).
    setInterval(detectHumanTyping, HUMAN_POLL_MS);
    // #B.149: track the "settled" status so the count-refresh below
    // doesn't reset bar to idle while claude is busy. tryWake flips
    // to busy on wake; we mirror that. Boot stays until settleBoot.
    // #B.173 (david skybot bug): heartbeat pane-probe flips between
    // `busy` and `idle` based on `esc to interrupt`, covering slash
    // commands (/compact, /clear) that don't fire Stop hook.
    let settledStatus: "boot" | "idle" | "busy" = "boot";
    while (tmuxAlive()) {
        // #B.205: when busy-defer is armed, cap the heartbeat sleep at
        // the defer deadline so the post-defer work-check happens
        // promptly. Without this, an `idle:wait` armed for 5s could
        // sit unchecked for up to `interval` seconds (default 30s) if
        // no SSE ping arrived in the gap — david: "c'est pas appelé
        // tout le temps. et il faudrait tester en interne si il y a
        // encore du travail à ce moment".
        const defer = readBusyDefer(sd!);
        const sleepMs = defer ? Math.min(interval * 1000, defer.activeMs) : interval * 1000;
        const sleptToDeferDeadline = defer !== null && sleepMs === defer.activeMs;
        await sleep(sleepMs);
        // #B.212 david: when the heartbeat sleep was capped at the
        // defer deadline, log the expiry so the log isn't silent
        // between "BUSY-DEFER armed" and the next event. Without this,
        // a 5s defer ending in a quiet window (no SSE ping, no work)
        // produced no log at deadline — looked like the loop forgot.
        if (sleptToDeferDeadline) {
            log(`busy-defer window expired (slept ${sleepMs}ms) — checking work`);
        }
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
        if (woke) {
            if (settledStatus !== "busy") log(`heartbeat: woke=true settledStatus=${settledStatus}→busy`);
            settledStatus = "busy";
        } else if (existsSync(idleMarkerPath(sd!))) {
            // #B.228: trace the boot→idle flip driven by the
            // idle-marker (set by settleBoot or session-start-hook).
            if (settledStatus !== "idle") log(`heartbeat: woke=false idle-marker present → settledStatus=${settledStatus}→idle`);
            settledStatus = "idle";
            // #251: idle + nothing to wake on = the safe lull to pick up
            // new code. Re-execs the timer in place if the source SHA
            // moved since boot (claude pane untouched). Never mid-turn
            // (idle-marker gates it), never when there's work (a wake
            // would have fired above → woke=true → this branch skipped).
            // Exits the process on reload, so it must come last here.
            selfReloadIfStale();
        }
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
                // #B.228: trace probe-driven state flips so a
                // "barre reste jaune" repro shows whether the
                // probe ever fired and what it saw.
                log(`probe: claudeWorking=true settledStatus=${settledStatus}→busy (bootSettled=true)`);
                settledStatus = "busy";
                bootSettled = true; // probe overrides boot grace
            } else if (claudeReady && !claudeWorking && settledStatus !== "idle") {
                // Claude is at the prompt. Seed idle-since so the
                // next tryWake has a clean gate and flip the bar.
                log(`probe: claudeReady=true settledStatus=${settledStatus}→idle (bootSettled=true, writing idle-marker)`);
                settledStatus = "idle";
                bootSettled = true;
                try {
                    const { writeFileSync } = await import("node:fs");
                    writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
                } catch { /* ignore */ }
            } else if (!claudeWorking && !claudeReady && settledStatus === "boot") {
                // #B.228: ambiguous pane during boot — log once-ish
                // so the repro shows the probe IS firing but the
                // regex isn't matching. Cheap enough to log every
                // tick during boot; goes quiet after settledStatus
                // leaves "boot".
                log(`probe: pane ambiguous (claudeReady=false claudeWorking=false) — settledStatus stays "boot"`);
            }
            // Else: pane present but ambiguous AND settledStatus
            // already left "boot" → keep settledStatus (no log).
        } else {
            // #B.228: empty pane capture. capturePane() returns ""
            // on failure — possibly tmux gone or capture errored.
            // Useful signal for the "barre reste jaune" repro.
            if (settledStatus === "boot") {
                log(`probe: empty pane capture (capturePane failed) — settledStatus stays "boot"`);
            }
        }
        // Refresh the bar with the current unread count (#B.149
        // david: "dans la barre mux on peut afficher le nombre de
        // read / ticket meme en idle ?"). Skipped while booting —
        // count is meaningless until settleBoot or the probe
        // detected claude is ready (whichever comes first).
        if (settledStatus !== "boot") {
            try {
                const r = await client().pingsCount() as { unread?: number };
                // #B.198: during user-grace, the third arg is the
                // grace label ("user") instead of the unread count —
                // matches the Stop hook's `[idle:user]` rendering so
                // the bar stays consistent across the whole window.
                // Count comes back once grace lapses.
                if (settledStatus === "idle" && userIsTakingOver(sd!, userGraceSec)) {
                    setTmuxStatus(name!, settledStatus, "user");
                } else {
                    setTmuxStatus(name!, settledStatus, r.unread ?? 0);
                }
            } catch { /* swallow — bar stays as-is */ }
        }
        // #B.177 B1: heartbeat push of current state to the daemon
        // so the consumers panel shows `[busy]`/`[idle]`/`[boot]` per
        // agent + an "offline" badge after the heartbeat goes stale.
        // Fire on EVERY tick (not just transitions) — the daemon
        // updates `state_updated_at` always, freshness signal for
        // the UI's offline detector.
        // #280: also push live human-presence so the panel can render
        // `human` vs autonomous `loop` while the heartbeat is fresh —
        // same signal the tmux bar uses for its loop/stop word (a human
        // typing now, or within user-grace after a manual prompt).
        try {
            const human = userIsTakingOver(sd!, userGraceSec) || humanIsTyping(sd!);
            await client().pushState(settledStatus, human);
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
    // #B.225: same boot SHA log as mainSse — see comment there.
    const bootSha = installRootSha();
    if (bootSha) log(`timer source: install-root SHA ${bootSha.slice(0, 7)}`);
    // Same startup safety net as SSE mode (#B.148): drain any
    // pre-existing work right away instead of waiting `interval`s.
    await tryWake("startup");
    while (tmuxAlive()) {
        // #B.205: cap sleep at busy-defer deadline (see mainSse note).
        const defer = readBusyDefer(sd!);
        const sleepMs = defer ? Math.min(interval * 1000, defer.activeMs) : interval * 1000;
        const sleptToDeferDeadline = defer !== null && sleepMs === defer.activeMs;
        await sleep(sleepMs);
        if (sleptToDeferDeadline) {
            log(`busy-defer window expired (slept ${sleepMs}ms) — checking work`);
        }
        const manualWake = existsSync(wakeRequestedPath(sd!));
        const woke = await tryWake(manualWake ? "manual" : "check-cmd hit", manualWake);
        // #251: same idle-gated self-reload as mainSse — pick up moved
        // source only in the lull (no wake fired AND claude is idle).
        if (!woke && existsSync(idleMarkerPath(sd!))) selfReloadIfStale();
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
