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
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import { DEFAULT_USER_GRACE_SEC, LOOP_STATUS, MUX_CMD, PANE_BUSY_DELAY_MS, WAKE_COALESCE_WINDOW_MS, armBusyDefer, buildContextPhrase, checkHasWork, formatPaneSnapshot, humanPresent, idleMarkerPath, injectWakePhrase, lastWakeAtPath, pingsPath, recordOpenWakeCount, paneShowsInterrupted, setTmuxStatus, snapshotPane, tmuxName, userTookOverPath, wakeInFlightPath } from "./state.js";
import { armErrorBackoff, matchPaneError, resetErrorBackoff } from "./error-backoff.js";
import { captureTokenUsage, projectTranscriptDir } from "./token-capture.js";
import { CL_ENV } from "./env-vars.js";
import { createLogger } from "../log.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
const checkCmd = process.env[CL_ENV.CHECK_CMD] ?? "true";
const userGraceSec = Math.max(0, Number(process.env[CL_ENV.USER_GRACE_SEC] ?? DEFAULT_USER_GRACE_SEC));
if (!sd || !name) emit();

// #B.149: tail-friendly log of every Stop hook fire — so we can spot
// from outside the session whether the hook actually ran, what branch
// it took, and any error. Replaces the previous swallow-on-error
// silence that made misfires invisible. tail -f via
// `claude-loop tail <name> --stop-hook` (planned subcommand) or
// `tail -f ~/.claude-loop/<name>/stop-hook.log`.
// #412: route stop-hook.log through the level logger (no tag → `<ts> LEVEL msg`).
// Existing calls map to `info` (default output preserved, now with the LEVEL
// token); the hook inherits CL_LOG_LEVEL from the sourced env file.
const logger = createLogger({
    write: (line) => {
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
 * kind of turn was this": user-driven, auto-wake-driven, or
 * autonomous (claude continued on its own). Comparison of marker
 * ages gives a reliable signal:
 *   - whichever of user-took-over / last-wake is more recent wins
 *   - if both are stale (> userGraceSec), call it "autonomous"
 *   - if neither marker exists → "?" (first fire / pruned state)
 *
 * The trailing markers stay raw so the reader can sanity-check the
 * classification or spot edge cases (wake-in-flight still set = the
 * UserPromptSubmit hook didn't get a chance to clean up).
 */
function ageMs(p: string): number | null {
    if (!existsSync(p)) return null;
    try { return Date.now() - statSync(p).mtimeMs; }
    catch { return null; }
}
function fmt(ms: number | null): string {
    return ms === null ? "-" : `${Math.round(ms / 1000)}s`;
}
function classifyTurn(): string {
    const wake = ageMs(lastWakeAtPath(sd!));
    const user = ageMs(userTookOverPath(sd!));
    const inflight = ageMs(wakeInFlightPath(sd!));
    // Whichever marker is more recent likely triggered THIS turn —
    // no time cutoff (claude turns can legitimately run minutes on
    // tool chains, so capping by user-grace mis-labeled long
    // auto-wake replies as "autonomous").
    let turn = "?";
    if (wake === null && user === null) turn = "?";
    else if (user !== null && (wake === null || user <= wake)) turn = "user";
    else turn = "auto-wake";
    return `turn=${turn} last-wake=${fmt(wake)} user-took-over=${fmt(user)} wake-in-flight=${fmt(inflight)}`;
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
        const errId = matchPaneError(paneText);
        if (errId) {
            const bo = armErrorBackoff(sd!, errId);
            // Claude is back at the prompt after the crashed turn — seed
            // idle-since so the timer is allowed to re-ping once the
            // backoff window elapses (it gates on the idle marker).
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, LOOP_STATUS.BUSY, `retry ${bo.attempts}`);
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
            setTmuxStatus(name!, LOOP_STATUS.BUSY, pane.special);
            log(`  → SUPPRESS (pane=${pane.special}) became=busy:${pane.special}`);
            emit();
        }
        // #B.195 — when the human typed within the user-grace window,
        // suppress the auto-ping. Otherwise the Stop hook fires
        // "Geronimo!" via send-keys right on top of the user's next
        // keystrokes ("pop culture en boucle"). The timer keeps
        // honoring user-took-over too, so nothing else wakes claude
        // until grace lapses. We still write idle-since so the bar
        // doesn't get stuck on busy when claude returns the prompt.
        // #501 david `73af3e` : stop ⊂ wait — un user qui tape MAINTENANT
        // (human-typing < 5s) est aussi "présent" et doit suppresser le wake,
        // pas juste celui qui a soumis < 60s (user-took-over). Sans cette
        // OR, le wake auto fire entre 2 frappes du user (entre submits) et
        // clobber la frappe en cours.
        if (humanPresent(sd!, userGraceSec)) {
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            // David #B.198: plain `[idle]` here mis-signaled "ready
            // for wakes" — we're actually deferring wakes. Surface
            // the user-grace caveat in the bar so the human reads it
            // as "claude IS at prompt, but we won't poke during grace".
            // #345 B: si claude a été interrompu, le marquer prime sur
            // `user` (plus spécifique que « grace humaine en cours »).
            const sub = interrupted ? "interrupted" : "user";
            setTmuxStatus(name!, LOOP_STATUS.IDLE, sub);
            log(`  → SUPPRESS (user-grace<${userGraceSec}s or typing-now) became=idle:${sub}`);
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
            const until = armBusyDefer(sd!, PANE_BUSY_DELAY_MS);
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            setTmuxStatus(name!, LOOP_STATUS.IDLE, "wait");
            log(`  → BUSY-DEFER armed until=${until} became=idle:wait`);
            emit();
        }
        const gate = await checkHasWork(checkCmd, undefined, process.env.AIBALL_PROJECT ?? null, sd!);
        log(`  checkHasWork=${gate.has} (pings=${gate.pingsCount} open=${gate.openCount})`);
        if (gate.has) {
            // #B.198 fix A: coalesce. If the previous wake fired
            // within the coalesce window, this Stop hook is the tail
            // of a burst (N events were unread, each turn drained one
            // and the chain rolls forward). Suppress the send-keys —
            // the next legit SSE event or heartbeat tick will wake
            // again, but without piling pop-culture phrases on top of
            // each other while claude is still visually finishing.
            const lastWakePath = lastWakeAtPath(sd!);
            const lastWakeMs = existsSync(lastWakePath) ? statSync(lastWakePath).mtimeMs : 0;
            const sinceLastWakeMs = Date.now() - lastWakeMs;
            if (lastWakeMs > 0 && sinceLastWakeMs < WAKE_COALESCE_WINDOW_MS) {
                writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
                setTmuxStatus(name!, LOOP_STATUS.IDLE);
                log(`  → COALESCE (last-wake=${sinceLastWakeMs}ms<${WAKE_COALESCE_WINDOW_MS}ms) became=idle`);
                emit();
            }
            // Work still pending — ping immediately, don't enter idle.
            // #B.221: wrap the culture phrase with state CTA so the
            // post-turn wake carries the same operational context as
            // the boot ping (counts + drain directive). Without this
            // the wake fires a bare "Excellent." and claude greets
            // back with no awareness of pending pings.
            const phrase = await buildContextPhrase(
                new AiballClient(),
                process.env.AIBALL_PROJECT ?? null,
                pingsPath(sd!),
            );
            // #B.180: mark this send-keys as auto-wake so the
            // UserPromptSubmit hook skips user-took-over.
            try { writeFileSync(wakeInFlightPath(sd!), new Date().toISOString() + "\n"); } catch { /* ignore */ }
            // #B.198 fix A: also touch the coalesce marker so the
            // next Stop hook fire can detect "we just sent a wake".
            try { writeFileSync(lastWakeAtPath(sd!), new Date().toISOString() + "\n"); } catch { /* ignore */ }
            await injectWakePhrase(`${tmuxName(name!)}.0`, phrase);
            // #B.232 ch887f: bump open-tickets watermark post-wake.
            if (gate.openCount > 0) recordOpenWakeCount(sd!, gate.openCount);
            setTmuxStatus(name!, LOOP_STATUS.BUSY);
            log(`  → WAKE '${phrase}' became=busy`);
        } else {
            // Nothing to do — mark idle so the timer can take over.
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
            // #345 B: garder le marqueur interrupted visible tant que le
            // pane le montre, même hors user-grace.
            setTmuxStatus(name!, LOOP_STATUS.IDLE, interrupted ? "interrupted" : undefined);
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
