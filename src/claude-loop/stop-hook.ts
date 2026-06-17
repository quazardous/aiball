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
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import { LOOP_SOCK_KIND, MUX_CMD, PANE_BUSY_DELAY_MS, humanPresentHold, buildContextPhrase, checkHasWork, formatPaneSnapshot, humanIsTyping, injectWakePhrase, pingsPath, readBusyDefer, paneShowsInterrupted, snapshotPane, tmuxName, WAKE_COALESCE_WINDOW_MS } from "./state.js";
import { getIpcState, setIpcStateTagInfo } from "./ipc-state.js";
import { armErrorBackoff, matchPaneError, resetErrorBackoff } from "./error-backoff.js";
import { captureTokenUsage, projectTranscriptDir } from "./token-capture.js";
import { CL_ENV } from "./env-vars.js";
import { createLogger } from "../log.js";
import { emitHookEventToTimer } from "./hook-emit.js";
import { sendEventOnce } from "./ipc-events.js";
import { loopSockPath } from "./state.js";
import { queryLoopState } from "./hook-verdict.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
const checkCmd = process.env[CL_ENV.CHECK_CMD] ?? "true";
if (!sd || !name) emit();

// #652 Slice 5 — emit the Stop event to the timer's HookService
// before the rest of the hook runs. Best-effort : if the timer isn't
// up the emit silently no-ops and the hook falls through to its
// existing wake / idle decision logic. Top-level await ; tsx + ES2022
// + NodeNext support it.
// #793 — emit the Stop event to the timer's loop-sock subscriber so
// the in-memory `IpcState.idleSinceMs` is set. No file fallback.
try {
    await emitHookEventToTimer(sd, { event: "hook", kind: "Stop", at_ms: Date.now() });
} catch { /* best-effort emit, never block the hook */ }

// #840 Slice C1 (#766) — prime ipcState from the timer's live snapshot
// before any of the hook's marker reads (humanIsTyping, humanPresentHold,
// readBusyDefer). When the timer is up, this turns those calls into
// in-memory reads ; when it's down (cold boot, dead loop), strict-IPC
// mode stays off and the helpers fall back to their file shadows.
try { await queryLoopState(sd); } catch { /* fail-open */ }

// #B.149: tail-friendly log of every Stop hook fire — so we can spot
// from outside the session whether the hook actually ran, what branch
// it took, and any error. Replaces the previous swallow-on-error
// silence that made misfires invisible. tail -f via
// `claude-loop tail <name> --log` (which merges hook lines straight
// into the timer log, see #944).
//
// #412: tagged through the level logger.
// #944 Slice 1: ship each line over `loop.sock` as a LOG frame so the
// timer appends it to the unified loop log — `tail -f loop.log` shows
// hook + timer chronologically interleaved. Plus an unconditional
// append to the local `stop-hook.log` as a cold-boot safety (the timer
// may not be listening yet when the hook fires its first lines on a
// fresh session). The fire-and-forget UDS call doesn't await the WS
// handshake — the hook subprocess only lives ~50ms, so we can't sync
// on delivery. The dual-write tolerates ~120 bytes/line duplication ;
// Slice 2 (NDJSON) will revisit (likely : drop the file once the
// timer's pre-listen window is covered by a tmp-buffer).
const logger = createLogger({
    tag: `stop-hook:${name}`,
    write: (line) => {
        void sendEventOnce(
            loopSockPath(sd!),
            { kind: LOOP_SOCK_KIND.LOG, data: { line } },
            { timeoutMs: 100, throwOnError: false },
        ).catch(() => { /* timer down — file fallback below catches it */ });
        try { appendFileSync(join(sd!, "stop-hook.log"), line); } catch { /* nowhere to log */ }
    },
});
function log(msg: string): void {
    logger.info(msg);
}

/**
 * Compact characterization of the TURN that just ended (#B.198).
 *
 * By definition the Stop hook fires post-turn, so "was the loop
 * busy?" is always yes — useless. What david actually wants is "what
 * kind of turn was this": auto-wake-driven or unknown (#745 phase B
 * dropped the user-driven branch — the AFK SM owns that signal now).
 * The last-wake marker is the sole input.
 *
 * #840 `4z59jt` — IPC seul. Le stop-hook subprocess prime l'ipcState
 * via `queryLoopState` (UDS round-trip) avant cet appel, donc on a déjà
 * `lastWakeAtMs` / `wakeInFlightAtMs` en mémoire.
 */
function fmt(ms: number | null): string {
    return ms === null ? "-" : `${Math.round(ms / 1000)}s`;
}
function ageFromIpc(tsMs: number | null): number | null {
    if (tsMs === null) return null;
    return Math.max(0, Date.now() - tsMs);
}
function classifyTurn(): string {
    // #745 phase B — user-took-over read dropped. AFK SM owns the
    // "this turn was a human prompt" signal now.
    const ipc = getIpcState();
    const wake = ageFromIpc(ipc.lastWakeAtMs);
    const inflight = ageFromIpc(ipc.wakeInFlightAtMs);
    const turn = wake !== null ? "auto-wake" : "?";
    return `turn=${turn} last-wake=${fmt(wake)} wake-in-flight=${fmt(inflight)}`;
}

// #B.154 / #B.198: probe the visible pane via the shared
// `snapshotPane` service (state.ts). Returns `{ busy, special }` —
// the same snapshot is logged on every FIRE so david can see what the
// hook saw (#B.198 david: "ajoute la detection esc to interrupt dans
// les log").
//
// `special` (compacting / rate-limit / api-error) STILL suppresses
// the wake — pane-persistent conditions where any send-keys queues
// uselessly. `busy` (esc-to-interrupt) is recorded for visibility but
// does NOT suppress here: per #B.185 the Stop hook fires post-turn so
// the footer text is by definition stale; gating on it left the bar
// stuck on busy forever (david: "claude-loop reste encore en busy
// alors qu'on a fait plusieur tour de ping → hook stop").
function readPane(): string {
    try {
        const r = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tmuxName(name!)}.0`, "-p",
        ], { encoding: "utf8" });
        return r.stdout ?? "";
    } catch { return ""; }
}

(async () => {
    const paneText = readPane();
    const pane = snapshotPane(paneText);
    // #345 B: claude a-t-il été interrompu (ESC) et bailé mid-turn ? Sert
    // UNIQUEMENT à décorer la barre `[idle:interrupted]` (précédence sur
    // `idle:user`) — aucun impact sur le gating des wakes.
    const interrupted = paneShowsInterrupted(paneText);
    log(`FIRE — ${classifyTurn()} | ${formatPaneSnapshot(pane)} | checkCmd=${checkCmd}`);
    // #404/#406 (david wezr82 "ça bouge plus"): capture this turn's token usage
    // FIRST — before any wake-decision branch below that emit()-exits the
    // process (error-backoff, pane-special, user-grace, BUSY-DEFER, coalesce).
    // The Stop hook fires post-turn while the pane usually still shows busy, so
    // the previous placement (after the gate) armed busy-defer and exited before
    // ever capturing → only the rare non-busy turn was counted. Capture is
    // independent of the wake logic; awaited so the POST flushes; never throws.
    try {
        // #634 david `svzkpw` — pass the loop's project as the no-marker
        // fallback : a direct session (no ticket-scoped MCP call) attributes
        // its turn tokens to the project tally instead of dropping them.
        const fallbackProject = process.env.AIBALL_PROJECT || undefined;
        const cap = await captureTokenUsage({
            transcriptDir: projectTranscriptDir(process.cwd()),
            stateDir: sd!,
            postUsage: (ticketId, u) => new AiballClient().postTokenUsage(ticketId, u),
            fallbackProject,
            postProjectUsage: (project, u) => new AiballClient().postProjectTokenUsage(project, u),
        });
        const detail = cap.status === "pushed"
            ? ` #${cap.ticketId} (+in${cap.turn.in}/out${cap.turn.out}/cw${cap.turn.cacheW}/cr${cap.turn.cacheR})`
            : cap.status === "pushed-project"
            ? ` ${cap.project} (+in${cap.turn.in}/out${cap.turn.out}/cw${cap.turn.cacheW}/cr${cap.turn.cacheR})`
            : "ticketId" in cap ? ` #${cap.ticketId}`
            : "project" in cap ? ` ${cap.project}`
            : "id" in cap ? ` ${cap.id}` : "";
        log(`  token-capture: ${cap.status}${detail}`);
    } catch (e) { log(`  token-capture: ERROR ${(e as Error).message ?? String(e)}`); }
    try {
        // #332: a recognized API/backend error crashed this turn. Don't
        // re-ping (it hammers the API and pops claude out of the flow).
        // Arm a dumb exponential backoff defer; the timer resumes after
        // the window. Still erroring → counter grows the next wait.
        //
        // #948 david `9hafg2` : gate on `!paneBusy`. Symmetric to the
        // timer-side gate ; claude actively retrying = error past tense,
        // don't re-arm backoff on the stale banner sitting in the
        // 8-line footer scrollback.
        const errId = getIpcState().paneBusy ? null : matchPaneError(paneText);
        if (errId) {
            const bo = armErrorBackoff(sd!, errId);
            // Claude is back at the prompt after the crashed turn — seed
            // idle-since so the timer is allowed to re-ping once the
            // backoff window elapses (it gates on the idle marker).
            // #793 — idle-since lives in the bus (set via the Stop event
            // emitted to the timer below). No file marker anymore.
            setIpcStateTagInfo(`retry ${bo.attempts}`);
            log(`  → ERROR-BACKOFF '${errId}' ${bo.ms}ms (attempt ${bo.attempts}) until=${bo.untilIso} became=busy:retry ${bo.attempts}`);
            emit();
        }
        // No error in the pane → the flow recovered; clear any backoff
        // counter so the next error restarts at the base delay.
        resetErrorBackoff(sd!);
        if (pane.special !== null) {
            // Suppress wake — claude is doing something internal
            // (compacting, etc.) or blocked on backend. Surface the
            // SUB-STATE in the bar as a `busy:<special>` suffix.
            setIpcStateTagInfo(pane.special);
            log(`  → SUPPRESS (pane=${pane.special}) became=busy:${pane.special}`);
            emit();
        }
        // Suppress the auto-ping when a human is present. Otherwise
        // the Stop hook fires "Geronimo!" via send-keys right on top
        // of the user's next keystrokes ("pop culture en boucle").
        // We still write idle-since so the bar doesn't get stuck on
        // busy when claude returns the prompt.
        //
        // #745 phase B — "human present" = AFK SM hold active OR
        // typing-now (human-typing < 5s). Either signal suppresses
        // the auto-wake ; otherwise fall through to the regular gate.
        // The AFK SM owns the longer-lived "human here" signal end-
        // to-end (typing arms NOT AFK 10m via the proxy).
        if (humanIsTyping(sd!) || humanPresentHold(sd!)) {
            // #793 — idle-since lives in the bus (set via the Stop event
            // emitted to the timer below). No file marker anymore.
            const sub = interrupted ? "interrupted" : "user";
            setIpcStateTagInfo(sub);
            log(`  → SUPPRESS (human-typing or AFK hold) became=idle:${sub}`);
            emit();
        }
        // #B.198 — arm the `busy-defer-until` marker (state-based, not
        // an in-hook `await sleep`) so the defer survives this hook
        // process exiting. Timer's tryWake honors it on next tick.
        //
        // #B.203 — show `[idle:wait]`: Stop fires POST-turn so the
        // pane.busy snapshot is stale; by defer-arm time claude is
        // almost certainly back at the prompt. Seed idle-since so
        // subsequent state consumers (heartbeat probe, count
        // refresh) treat claude as at the prompt. The defer marker
        // still silently gates wakes during the window.
        if (pane.busy && PANE_BUSY_DELAY_MS > 0) {
            // #839 Slice 2 (#766) — hook emits the busy-defer expiry to
            // the timer ; the timer's HookService subscriber writes both
            // the IPC field AND the `busy-defer-until` shadow file (via
            // armBusyDefer reused inside the subscriber). No local file
            // write here anymore — the timer is the single writer.
            const untilMs = Date.now() + PANE_BUSY_DELAY_MS;
            await emitHookEventToTimer(sd!, {
                event: "hook",
                kind: "Stop",
                at_ms: Date.now(),
                busy_defer_until_ms: untilMs,
            });
            setIpcStateTagInfo("wait");
            log(`  → BUSY-DEFER armed until=${new Date(untilMs).toISOString()} became=idle:wait`);
            emit();
        }
        // Respect the post-wake tempo: if a wake already fired in the
        // last WAKE_COALESCE_WINDOW_MS the inject site has armed
        // busy-defer. A second Stop arriving inside that window (claude
        // emits multiple Stop events per turn for tool-then-text bursts)
        // must NOT inject again — that's how a single FIFO event ends up
        // sent to the agent twice.
        const defer = readBusyDefer(sd!);
        if (defer && defer.activeMs > 0) {
            // #793 — idle-since lives in the bus (set via the Stop event
            // emitted to the timer below). No file marker anymore.
            setIpcStateTagInfo("wait");
            log(`  → SKIP (busy-defer ${defer.activeMs}ms remaining) became=idle:wait`);
            emit();
        }
        const gate = await checkHasWork(checkCmd, undefined, process.env.AIBALL_PROJECT ?? null, sd!);
        log(`  checkHasWork=${gate.has} (pings=${gate.pingsCount} open=${gate.openCount})`);
        if (gate.has) {
            const phraseClient = new AiballClient();
            const { phrase, headMessageId, backlogTicketId } = await buildContextPhrase(
                phraseClient,
                process.env.AIBALL_PROJECT ?? null,
                pingsPath(sd!),
            );
            // #B.180: mark this send-keys as auto-wake so the
            // UserPromptSubmit hook can flag from_auto_wake=true
            // and the timer keeps idleSinceMs (no human submission).
            // #839 Slice 2 (#766) — the wake-in-flight + last-wake-at
            // shadow files are now written EXCLUSIVELY by the timer's
            // dispatcher on receipt of the markers below. The hook just
            // emits ; no more local writeFileSync.
            const wakeAtMs = Date.now();
            void sendEventOnce(loopSockPath(sd!), {
                kind: "proxyEvent",
                data: { event: "marker", name: "set_wake_in_flight", at_ms: wakeAtMs, now_ms: wakeAtMs },
            }, { timeoutMs: 200 });
            void sendEventOnce(loopSockPath(sd!), {
                kind: "proxyEvent",
                data: { event: "marker", name: "set_last_wake_at", at_ms: wakeAtMs, now_ms: wakeAtMs },
            }, { timeoutMs: 200 });
            const wakeDelivered = await injectWakePhrase(`${tmuxName(name!)}.0`, phrase, () => {
                // Post-wake tempo — emit busy_defer_until via a Stop event
                // (= same channel the pane-busy branch above uses). The
                // dispatcher's HookService subscriber materializes the
                // `busy-defer-until` shadow file from this signal (#839
                // Slice 2). No local armBusyDefer call.
                const tempoUntilMs = Date.now() + WAKE_COALESCE_WINDOW_MS;
                void emitHookEventToTimer(sd!, {
                    event: "hook",
                    kind: "Stop",
                    at_ms: Date.now(),
                    busy_defer_until_ms: tempoUntilMs,
                });
                if (headMessageId) {
                    void phraseClient.markMessageSeen(headMessageId).catch(() => {});
                }
                // #786 — backlog cooldown clock (see timer.ts sendKeys).
                if (backlogTicketId) {
                    void phraseClient.recordBacklogWake(backlogTicketId).catch(() => {});
                }
            });
            // #974 — fail loud : proxy attendu mais inject KO (pas de
            // fallback tmux qui ré-armerait NOT AFK 10m). Wake droppé.
            if (!wakeDelivered) {
                log("wake: injectWakePhrase FAILED via proxy (loop.sock present, inject KO) — proxy bug ? wake dropped, NO tmux fallback. Investigate.");
            }
            setIpcStateTagInfo(null);
            log(`  → WAKE '${phrase}' became=busy`);
        } else {
            // Nothing to do — mark idle so the timer can take over.
            // #793 — idle-since lives in the bus (set via the Stop event
            // emitted to the timer below). No file marker anymore.
            // #345 B: garder le marqueur interrupted visible tant que le
            // pane le montre, même hors user-grace.
            setIpcStateTagInfo(interrupted ? "interrupted" : null);
            log(`  → IDLE (no work) became=idle${interrupted ? ":interrupted" : ""}`);
        }
    } catch (e) {
        log(`  → ERROR ${(e as Error).message ?? String(e)}`);
    }
    // #404/#406: token capture now runs at the TOP of the hook (it used to sit
    // here, but the busy-defer / grace / coalesce branches emit()-exit before
    // reaching it — david wezr82 "ça bouge plus"). This fall-through only needs
    // to emit for the WAKE / IDLE-no-work paths.
    emit();
})();
