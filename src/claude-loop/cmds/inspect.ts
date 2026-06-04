/**
 * `claude-loop inspect <name>` — JSON dump of a loop's full state.
 *
 * Slice 1 of #613 (fake-claude integration testing). The dump bundles
 * everything an external observer would otherwise have to scrape from
 * markers + timer.log + ps : pure read, no side-effects, exits 0/1
 * depending on whether the state-dir exists. Pytest harnesses (slice 3+)
 * spawn the loop, wait a tick, then `claude-loop inspect <name>` to
 * assert behaviour without poking at the fs directly.
 *
 * The JSON shape mirrors `LoopStateView` from loop-state.ts plus a few
 * runtime extras (timer pid + alive, proxy pid + alive, loop start time,
 * resolved boot thresholds) — everything you need to verify a scenario.
 *
 * Output is canonical : sorted keys, no `null` collapse, stable across
 * runs except for the timestamps. Pytest can pick exact keys to assert
 * (`d["boot"]["in_grace"]`) without depending on serialization quirks.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
    bootCompletePath,
    humanTypingPath,
    idleMarkerPath,
    proxyAlivePath,
    readLoopStateInput,
    resumeSessionPickerActivePath,
    resumeModePickerActivePath,
    stateDirFor,
    timerPidPath,
    wakeInFlightPath,
    wakeRequestedPath,
} from "../state.js";
import { computeLoopView } from "../loop-state.js";

function pidAlive(pidPath: string): { pid: number | null; alive: boolean } {
    if (!existsSync(pidPath)) return { pid: null, alive: false };
    try {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (!Number.isFinite(pid) || pid <= 0) return { pid: null, alive: false };
        try { process.kill(pid, 0); return { pid, alive: true }; }
        catch { return { pid, alive: false }; }
    } catch { return { pid: null, alive: false }; }
}

function mtimeIso(path: string): string | null {
    try { return existsSync(path) ? new Date(statSync(path).mtimeMs).toISOString() : null; }
    catch { return null; }
}

export function cmdInspect(name: string): void {
    const sd = stateDirFor(name);
    if (!existsSync(sd)) {
        process.stdout.write(JSON.stringify({ name, exists: false }, null, 2) + "\n");
        process.exit(1);
    }
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
    const timer = pidAlive(timerPidPath(sd));
    const proxy = pidAlive(proxyAlivePath(sd));
    const dump = {
        name,
        exists: true,
        state_dir: sd,
        loop_start_ms: input.loopStartMs,
        loop_start_iso: new Date(input.loopStartMs).toISOString(),
        now_ms: input.nowMs,
        view: {
            phase: view.phase,
            bar_word: view.barWord,
            in_boot_grace: view.inBootGrace,
            afk_chunk: view.afkChunk,
            wake_allowed: view.wakeAllowed,
            wake_skip_reason: view.wakeSkipReason,
        },
        boot: {
            min_ms: input.bootMinMs,
            grace_ms: input.bootGraceMs,
            elapsed_ms: input.nowMs - input.loopStartMs,
            complete_marker: existsSync(bootCompletePath(sd)),
            resume_session_picker_active: existsSync(resumeSessionPickerActivePath(sd)),
            resume_mode_picker_active: existsSync(resumeModePickerActivePath(sd)),
        },
        // #733 V2 — pane signals live in the timer's `ipcState` only ;
        // a subprocess view (this command) sees `false` for everything
        // unless/until a cross-process query path is added (#771).
        pane: {
            busy: input.paneBusy,
            ready: input.paneReady,
            compacting: input.paneCompacting,
            resuming: false,
            interrupted: input.paneInterrupted,
            _from_subprocess: true,
        },
        afk: {
            mode: input.afkMode,
            expiry_ms: input.afkExpiryMs,
            expiry_iso: input.afkExpiryMs !== null ? new Date(input.afkExpiryMs).toISOString() : null,
        },
        wake: {
            in_flight_at_ms: input.wakeInFlightAtMs,
            in_flight_ttl_ms: input.wakeInFlightTtlMs,
            busy_defer_until_ms: input.busyDeferUntilMs,
            requested_marker: existsSync(wakeRequestedPath(sd)),
        },
        typing: {
            at_ms: input.humanTypingAtMs,
            at_iso: input.humanTypingAtMs !== null ? new Date(input.humanTypingAtMs).toISOString() : null,
            ttl_ms: input.humanTypingTtlMs,
        },
        markers: {
            idle_since_iso: mtimeIso(idleMarkerPath(sd)),
            human_typing_iso: mtimeIso(humanTypingPath(sd)),
            wake_in_flight_iso: mtimeIso(wakeInFlightPath(sd)),
        },
        runtime: {
            timer: timer,
            proxy: proxy,
            no_wait: input.noWait,
        },
    };
    process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
}
