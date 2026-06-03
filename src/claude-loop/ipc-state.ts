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
    /** Slice B-2 : in-memory busy-defer expiry (ms epoch). Set by the
     *  Stop hook when claude returns but the pane is still busy ; the
     *  gate refuses wakes until `nowMs >= busyDeferUntilMs`. `null` =
     *  no signal yet (fall back to the busy-defer-until file). */
    busyDeferUntilMs: number | null;
    /** Slice B-2 : in-memory picker state. SessionStart hook detects
     *  the resume picker on first paint + emits the flags ; the timer
     *  uses them as a `boot-stretched-by-picker` signal in the wake
     *  gate. `null` = no signal yet. */
    resumeSessionPickerActive: boolean | null;
    resumeModePickerActive: boolean | null;
    /** V4 Phase 1 — timer-local wake bookkeeping. Pure in-memory ;
     *  restart-loss is acceptable (a rare double-wake right after a
     *  timer respawn beats the file-marker complexity). */
    lastOpenWakeHash: string | null;
    drainedState: import("./drained-strategy.js").DrainedState | null;
    lastWakeHint: { ticket_id?: number; comment_hashid?: string; at_ms: number } | null;
    /** V4 Phase 2 — landscape open-count dedup watermark (#B.232). Written
     *  by the timer in-process and by the stop-hook subprocess (via a
     *  marker emit on `loop.sock` that the dispatcher routes back into
     *  this field). Read by the wake gate. */
    lastOpenWakeCount: number | null;
    /** V4 Phase 3 — phrase dedup payload (`<iso>|<hash>` format from
     *  `dedupeWakeInjection`). Shadow of `last-injected-wake` marker
     *  for the timer's in-memory dedup check. The file marker is still
     *  written (back-compat for stop-hook subprocess reads), V5 will
     *  drop it when wake dedup centralises on the timer's loopServer. */
    lastInjectedWake: string | null;
    /** V4 Phase 3 — ms-since-epoch of the last wake injection. Mirror
     *  of the `last-wake-at` marker for the timer's in-process reads. */
    lastWakeAtMs: number | null;
    /** V5 Phase A — `claude-loop wake <name>` toggled this flag (via
     *  a `set_wake_requested` marker emit on `loop.sock`). The timer's
     *  wake gate consults it as a check-cmd bypass + unlinks it on
     *  consume. `null` = no pending request. */
    wakeRequestedAtMs: number | null;
}

const state: IpcState = {
    bootComplete: null,
    idleSinceMs: null,
    idleSinceCleared: false,
    busyDeferUntilMs: null,
    resumeSessionPickerActive: null,
    resumeModePickerActive: null,
    lastOpenWakeHash: null,
    drainedState: null,
    lastWakeHint: null,
    lastOpenWakeCount: null,
    lastInjectedWake: null,
    lastWakeAtMs: null,
    wakeRequestedAtMs: null,
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

/** Slice B-2 : in-memory busy-defer expiry. Set by the Stop hook event
 *  when the pane is busy at turn end. `null` clears the override (gate
 *  falls back to the file). */
export function setIpcBusyDeferUntil(atMs: number | null): void {
    state.busyDeferUntilMs = atMs;
}

/** Slice B-2 : in-memory picker flags. SessionStart hook reports each
 *  flag independently. `null` = no signal yet (file fallback). */
export function setIpcResumeSessionPicker(active: boolean | null): void {
    state.resumeSessionPickerActive = active;
}

export function setIpcResumeModePicker(active: boolean | null): void {
    state.resumeModePickerActive = active;
}

/** V4 Phase 1 — timer-only wake bookkeeping setters. Pure in-memory ;
 *  callers used to round-trip through the `last-open-wake-hash` /
 *  `drained-state` / `last-wake-hint` marker files. */
export function setIpcLastOpenWakeHash(hash: string | null): void {
    state.lastOpenWakeHash = hash;
}

export function setIpcDrainedState(value: import("./drained-strategy.js").DrainedState | null): void {
    state.drainedState = value;
}

export function setIpcLastWakeHint(
    hint: { ticket_id?: number; comment_hashid?: string; at_ms: number } | null,
): void {
    state.lastWakeHint = hint;
}

export function setIpcLastOpenWakeCount(count: number | null): void {
    state.lastOpenWakeCount = count;
}

export function setIpcLastInjectedWake(value: string | null): void {
    state.lastInjectedWake = value;
}

export function setIpcLastWakeAtMs(atMs: number | null): void {
    state.lastWakeAtMs = atMs;
}

export function setIpcWakeRequested(atMs: number | null): void {
    state.wakeRequestedAtMs = atMs;
}

/** Reset every field to the as-launched defaults. Tests only. */
export function resetIpcStateForTests(): void {
    state.bootComplete = null;
    state.idleSinceMs = null;
    state.idleSinceCleared = false;
    state.busyDeferUntilMs = null;
    state.resumeSessionPickerActive = null;
    state.resumeModePickerActive = null;
    state.lastOpenWakeHash = null;
    state.drainedState = null;
    state.lastWakeHint = null;
    state.lastOpenWakeCount = null;
    state.lastInjectedWake = null;
    state.lastWakeAtMs = null;
    state.wakeRequestedAtMs = null;
}
