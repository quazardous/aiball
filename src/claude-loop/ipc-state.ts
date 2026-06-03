/**
 * #727 V1 Slice B — in-memory mirror of fields that the hook subprocesses
 * used to communicate to the timer via marker files. The dispatcher
 * (`proxy-event-dispatcher.ts`) + a HookService subscriber installed by
 * the timer mutate this state directly when events arrive over
 * `loop.sock` ; `readLoopStateInput` then consults the in-memory value
 * first and falls back to the filesystem only when no signal has been
 * pushed (timer just restarted, or the hook fell back to file write
 * because the ws emit failed).
 *
 * Module-level singleton — the timer is a single Node process per loop
 * and `readLoopStateInput` runs in-process with the dispatcher + the
 * HookService subscriber, so no cross-process synchronisation is needed.
 * Tests reset via `resetIpcState()`.
 *
 * Scope of Slice B-1 (this commit) :
 *   - `bootComplete` : flipped on the SessionStart event ; read by
 *     `isInBootGrace`. The file `boot-complete` still gets written by
 *     the session-start hook for cross-process readers (cli inspect,
 *     fallback). The in-memory bit is just a faster + race-free signal
 *     for the timer's own gate.
 *   - `idleSinceMs` : the timestamp the Stop hook signalled "claude is
 *     at the prompt" — set on Stop, cleared on UserPromptSubmit. Same
 *     file shadow story.
 *
 * Slice B-2 will add `busyDeferUntilMs` + the picker markers ; Slice B-3
 * will let the hooks skip the file write when the ws emit succeeds (so
 * the timer becomes the sole writer + the markers can disappear in V4).
 */

export interface IpcState {
    /** Last in-memory boot-complete flag, mutated when a SessionStart
     *  event lands. `null` = no event yet (the timer just started and
     *  the file may still be the truth). */
    bootComplete: boolean | null;
    /** Last in-memory `idle-since` timestamp (ms epoch), mutated on
     *  Stop / SessionStart (set) and UserPromptSubmit (clear). `null`
     *  preserves the previous fallback-to-file behaviour. */
    idleSinceMs: number | null;
    /** Sentinel : true when the timer subscriber has explicitly cleared
     *  `idleSinceMs` on a UserPromptSubmit event. Lets `readLoopStateInput`
     *  distinguish "no signal yet, read the file" from "human typed,
     *  override the file mtime with null". */
    idleSinceCleared: boolean;
}

const state: IpcState = {
    bootComplete: null,
    idleSinceMs: null,
    idleSinceCleared: false,
};

/** Read-only view of the current state. Callers should not mutate. */
export function getIpcState(): Readonly<IpcState> {
    return state;
}

/** Mark the loop as past the boot phase. Called on SessionStart event. */
export function setIpcBootComplete(value: boolean): void {
    state.bootComplete = value;
}

/** Record that claude returned to the prompt. Called on Stop event when
 *  the hook decides the pane is idle, and on SessionStart (boot ends
 *  with claude at the prompt). */
export function setIpcIdleSince(atMs: number | null): void {
    state.idleSinceMs = atMs;
    state.idleSinceCleared = atMs === null;
}

/** Reset every field to the as-launched defaults. Tests only. */
export function resetIpcStateForTests(): void {
    state.bootComplete = null;
    state.idleSinceMs = null;
    state.idleSinceCleared = false;
}
