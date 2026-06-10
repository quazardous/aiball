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
    /** #848 david `<chat>` : "green light" registre — set 10s après
     *  `boot:sealed` via BootController emit `loop:start`. C'est le flag
     *  que les consumers "fin de boot vraiment terminée" doivent gater
     *  (au lieu de `bootComplete` qui fire dès le seal technique). No-op
     *  si claude est busy au moment du set. */
    loopStart: boolean;
    /** Last in-memory `idle-since` timestamp (ms epoch), mutated on
     *  Stop / SessionStart (set) and UserPromptSubmit (clear). `null`
     *  preserves the previous fallback-to-file behaviour. */
    idleSinceMs: number | null;
    /** #805 david — epoch ms of the next scheduled `idle:settled` emit
     *  (= next periodic wake attempt). Computed by the IdleController
     *  bridge. Null when claude is busy/unknown. Read by the BarRenderer
     *  to render the countdown segment after `o:N b:N e:N`. */
    nextWakeAtMs: number | null;
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
    /** V4 Phase 3 — ms-since-epoch of the last wake injection. Mirror
     *  of the `last-wake-at` marker for the timer's in-process reads. */
    lastWakeAtMs: number | null;
    /** #856 Phase 3 — ms-since-epoch the most recent wake injection
     *  was armed. Mirror of the `wake-in-flight` marker for the timer's
     *  in-process reads. The marker has its own TTL (`WAKE_IN_FLIGHT_TTL_MS`)
     *  which `readLoopStateInput` enforces ; the field here is just the
     *  raw stamp. */
    wakeInFlightAtMs: number | null;
    /** V5 Phase A — `claude-loop wake <name>` toggled this flag (via
     *  a `set_wake_requested` marker emit on `loop.sock`). The timer's
     *  wake gate consults it as a check-cmd bypass + unlinks it on
     *  consume. `null` = no pending request. */
    wakeRequestedAtMs: number | null;
    /** #734 V3 Phase A — AFK state in-memory. `null` mode = no in-memory
     *  signal yet, fall back to the `afk` file (win32 path : the Rust
     *  proxy writes the file directly without going through proxyEvent,
     *  so ipcAfk stays null and the wake gate reads from disk). Set by
     *  the `Afk*ViaService` helpers on every Unix-side mutation. The
     *  fallback semantic mirrors `idleSinceMs` / `idleSinceCleared`
     *  (#727 B-1) — strict null-means-fallback per the `2a6eed8`
     *  regression lesson. */
    afkMode: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs: number | null;
    /** #751 jk5ngg htwguc qb7zs6 — `dispAfk` : la valeur AFK à afficher
     *  (chip visuel droite). Diverge de `afkMode` pendant la fenêtre
     *  debounce 3s d'un toggle F9 (= cycle visible instant, SM stable).
     *  Quand null, le chip rend `afkMode` (= state converged). Le couple
     *  (dispAfkMode, dispAfkExpiryMs, dispAfkCommitAtMs) est muté par
     *  `setIpcDispAfk` et observé via `LoopStateBus` event
     *  `dispAfkChanged`. Au commit (dispAfkCommitAtMs <= now) :
     *  - si `dispAfkMode === afkMode` (= le cycle revient au même kind),
     *    NOOP commit (clear juste dispAfk), le timer interne wait_10m
     *    reste sur sa course initiale (= vrai noop sur le SM, david
     *    `qb7zs6` "reste tant que l'état réel est pas changé") ;
     *  - sinon le timer's heartbeat appelle les `*ViaService` helpers
     *    qui updatent `afkMode` + AfkService observable + le fichier
     *    `afk` (= toujours là, kill prévu en #766) ; pas de stash
     *    artificiel (= david "le timer interne dois pas etre du tout
     *    sauver"). */
    dispAfkMode: "off" | "wait_10m" | "wait_inf" | null;
    dispAfkExpiryMs: number | null;
    /** ms-since-epoch quand le pending convergera vers `afk`. Un nouveau
     *  toggle dans la fenêtre RESET cette valeur (= push de 3s). */
    dispAfkCommitAtMs: number | null;
    /** #734 V3 Phase B — human-typing timestamp in-memory. `null` = no
     *  in-memory signal, fall back to `human-typing` file mtime. Set by
     *  the dispatcher on `keystroke:typing` events from the proxy. */
    humanTypingAtMs: number | null;
    /** #733 V2 — pane state in-memory, mirrored by every `setPane*`
     *  setter. `null` = no in-memory signal yet → reader falls back to
     *  the file (cold boot before `refreshPaneMarkers` runs, or a stale
     *  cli inspect from another process). Strict null-fallback per the
     *  `2a6eed8` lesson : a `false` is an EXPLICIT "pane signal NOT set",
     *  never confused with "no signal". The file is kept as a shadow for
     *  out-of-process readers (cli inspect, hook tests) until a follow-up
     *  drops it. */
    paneBusy: boolean | null;
    paneReady: boolean | null;
    paneCompacting: boolean | null;
    paneInterrupted: boolean | null;
    paneResuming: boolean | null;
    /** #860 — timestamp of the last `pushViewIfChanged` tick from the
     *  timer. Stamped via `setIpcLastViewPushAtMs` on every push. Reads
     *  via `queryLoopState` carry this so `claude-loop health` can flag
     *  a stale ipc (= timer alive but its bus loop has frozen). `null`
     *  pre-1st-push (cold boot). */
    lastViewPushAtMs: number | null;
    /** #862 — counters segment `@cl_counts` ground truth. Null = clear
     *  the segment ; an object overrides each named counter (null inside
     *  drops that specific counter). Mutated via `setIpcCounters` by the
     *  timer's count-refresh tick. Read by `BarRenderer` to compose the
     *  segment string. */
    counters: { open: number | null; backlog: number | null; events: number | null } | null;
    /** #869 — SSE connection state, flipped by `WakeBus` events. True
     *  while subscription is live, false on `error`, null pre-connect.
     *  Read by `claude-loop health.checkSse` — replaces the flaky
     *  time-since-last-event TTL (SSE events are demand-driven, quiet
     *  periods of 10+ min are normal). */
    sseConnected: boolean | null;
    /** David `<chat>` : watcher-driven boot deadline. Pushed to `now+10s`
     *  each time a pane watcher tick observes a "still booting" condition
     *  (paneReady=false / picker actif / compacting). When the deadline
     *  expires without further push, the BootMachine actor's external
     *  pump (bootDeadlineTimer in timer.ts) fires `DEADLINE_REACHED`
     *  → the actor transitions to `sealed` → subscriber writes
     *  bootComplete. Initialized at `loopStartMs + bootMinMs` (= 30s floor). */
    bootDeadlineMs: number | null;
    /** #867 — timestamp du dernier event SSE reçu du daemon (incluant
     *  les hints/pings). Read par `claude-loop health.checkSse` pour
     *  flag `stale SSE channel` quand le canal live a coupé. `null`
     *  pre-1st-event (cold boot, ou daemon down). */
    lastSseEventAtMs: number | null;
    /** #862 Slice 3 — substate hint that decorates the `@cl_state` tag
     *  (`[idle:wait]`, `[busy:compacting]`, `[busy:retry 3]`). Mutée par
     *  les call sites legacy `setTmuxStatus(name, status, info)` ;
     *  consumée par `BarRenderer.computeBarSnapshot`. `null` = pas de
     *  suffix → tag plein `[<status>]`. */
    stateTagInfo: string | null;
}

const state: IpcState = {
    bootComplete: null,
    loopStart: false,
    idleSinceMs: null,
    nextWakeAtMs: null,
    idleSinceCleared: false,
    busyDeferUntilMs: null,
    resumeSessionPickerActive: null,
    resumeModePickerActive: null,
    lastOpenWakeHash: null,
    drainedState: null,
    lastWakeHint: null,
    lastWakeAtMs: null,
    wakeInFlightAtMs: null,
    wakeRequestedAtMs: null,
    afkMode: null,
    afkExpiryMs: null,
    dispAfkMode: null,
    dispAfkExpiryMs: null,
    dispAfkCommitAtMs: null,
    humanTypingAtMs: null,
    paneBusy: null,
    paneReady: null,
    paneCompacting: null,
    paneInterrupted: null,
    paneResuming: null,
    lastViewPushAtMs: null,
    lastSseEventAtMs: null,
    sseConnected: null,
    bootDeadlineMs: null,
    counters: null,
    stateTagInfo: null,
};

/** Read-only view of the current state. Callers should not mutate. */
export function getIpcState(): Readonly<IpcState> {
    return state;
}

/** #840 `4z59jt` — david "vire tout marker fichier". Le gate strict
 *  est retiré : `readLoopStateInput` est TOUJOURS IPC-only (= safe
 *  defaults quand ipcState n'a pas la valeur). Les hook subprocesses
 *  primaient leur ipcState via `queryLoopState` (UDS round-trip vers
 *  le timer). UDS down → safe defaults (= AFK off, no marker active,
 *  boot grace floor). Pré-#840 ces paths retombaient sur readFromFile,
 *  ce qui pinning les markers. */

// #856 Phase 1 — in-process pub/sub on the ipcState. Each `setIpc*` calls
// `notifyIpcChanged()` after the mutation ; consumers (timer.ts subscribes
// from `schedulePush`) react in 50ms (debounced) and push the new view to
// the proxy. Replaces the `fs.watch` on the state-dir (timer.ts:1531) :
// the timer is the single writer of every marker shadow post-#839, so a
// watch firing on its own writes was wasted overhead + a race source.
// Tests stay green : `pushViewIfChanged`'s periodic 1s tick is the safety
// net, this just makes the push deterministic at the moment of the write.
const _ipcSubscribers = new Set<() => void>();
export function onIpcChanged(cb: () => void): () => void {
    _ipcSubscribers.add(cb);
    return () => { _ipcSubscribers.delete(cb); };
}
function notifyIpcChanged(): void {
    for (const cb of _ipcSubscribers) {
        try { cb(); } catch { /* a buggy subscriber shouldn't block others */ }
    }
}
/** Test helper : drop every subscriber. Useful when a test installs a
 *  subscriber then re-uses the singleton in another test (cross-test
 *  bleed). Production code never calls this — it's idempotent + cheap. */
export function _resetIpcSubscribersForTests(): void {
    _ipcSubscribers.clear();
}

/** Mark the loop as past the boot phase. Called on SessionStart event. */
export function setIpcBootComplete(value: boolean): void {
    state.bootComplete = value;
    notifyIpcChanged();
}

/** Record that claude returned to the prompt. Called on Stop event when
 *  the hook decides the pane is idle, and on SessionStart (boot ends
 *  with claude at the prompt). */
export function setIpcIdleSince(atMs: number | null): void {
    state.idleSinceMs = atMs;
    state.idleSinceCleared = atMs === null;
    notifyIpcChanged();
}

/** #805 — set the epoch ms of the next scheduled `idle:settled` emit.
 *  Bridge subscriber writes this from IdleController context.
 *  Null when claude is busy/unknown ; BarRenderer reads to render the
 *  countdown segment after `o:N b:N e:N`. */
export function setIpcNextWakeAt(atMs: number | null): void {
    state.nextWakeAtMs = atMs;
    notifyIpcChanged();
}

/** #848 — set the "loop:start" register (green light). Wired from
 *  BootController `loop:start` emit (= 10s after boot:sealed). Consumers
 *  gating on "boot really ended" check this instead of bootComplete. */
export function setIpcLoopStart(active: boolean): void {
    state.loopStart = active;
    notifyIpcChanged();
}

/** Slice B-2 : in-memory busy-defer expiry. Set by the Stop hook event
 *  when the pane is busy at turn end. `null` clears the override (gate
 *  falls back to the file). */
export function setIpcBusyDeferUntil(atMs: number | null): void {
    state.busyDeferUntilMs = atMs;
    notifyIpcChanged();
}

/** Slice B-2 : in-memory picker flags. SessionStart hook reports each
 *  flag independently. `null` = no signal yet (file fallback). */
export function setIpcResumeSessionPicker(active: boolean | null): void {
    state.resumeSessionPickerActive = active;
    notifyIpcChanged();
}

export function setIpcResumeModePicker(active: boolean | null): void {
    state.resumeModePickerActive = active;
    notifyIpcChanged();
}

/** V4 Phase 1 — timer-only wake bookkeeping setters. Pure in-memory ;
 *  callers used to round-trip through the `last-open-wake-hash` /
 *  `drained-state` / `last-wake-hint` marker files. */
export function setIpcLastOpenWakeHash(hash: string | null): void {
    state.lastOpenWakeHash = hash;
    notifyIpcChanged();
}

export function setIpcDrainedState(value: import("./drained-strategy.js").DrainedState | null): void {
    state.drainedState = value;
    notifyIpcChanged();
}

export function setIpcLastWakeHint(
    hint: { ticket_id?: number; comment_hashid?: string; at_ms: number } | null,
): void {
    state.lastWakeHint = hint;
    notifyIpcChanged();
}

export function setIpcLastWakeAtMs(atMs: number | null): void {
    state.lastWakeAtMs = atMs;
    notifyIpcChanged();
}

/** #856 Phase 3 — set the in-memory `wake-in-flight` stamp. Mirrors the
 *  `wake-in-flight` file marker so the timer's `readLoopStateInput`
 *  consults memory before the disk. `null` resets the in-memory signal
 *  (read path falls back to the file mtime). */
export function setIpcWakeInFlightAtMs(atMs: number | null): void {
    state.wakeInFlightAtMs = atMs;
    notifyIpcChanged();
}

export function setIpcWakeRequested(atMs: number | null): void {
    state.wakeRequestedAtMs = atMs;
    notifyIpcChanged();
}

/** #860 — stamp the last `pushViewIfChanged` tick. NOT pubsub-notified
 *  (would recurse via schedulePush → pushView → setIpcLastViewPushAtMs).
 *  Pure write ; read via `getIpcState().lastViewPushAtMs`. */
export function setIpcLastViewPushAtMs(atMs: number | null): void {
    state.lastViewPushAtMs = atMs;
}

/** #867 — stamp le moment du dernier event SSE reçu. Pas pubsub-notified
 *  (= ne déclenche pas onIpcChanged, sinon ré-entrance bus). Lu via
 *  `getIpcState().lastSseEventAtMs` puis surfacé par `queryLoopState`. */
export function setIpcLastSseEventAtMs(atMs: number | null): void {
    state.lastSseEventAtMs = atMs;
}

/** #869 — flag SSE connection alive/down. Pas pubsub-notified (= les
 *  consumers lisent à la demande via queryLoopState). */
export function setIpcSseConnected(connected: boolean | null): void {
    state.sseConnected = connected;
}

/** David `<chat>` : push le deadline boot (watcher-driven). Pas pubsub-
 *  notified (= changement régulier toutes les ~1s pendant boot, on évite
 *  d'inonder le bus). Le BarRenderer le lit via `getIpcState()` à chaque
 *  safety tick 1s. */
export function setIpcBootDeadlineMs(atMs: number | null): void {
    state.bootDeadlineMs = atMs;
}

/** #862 Slice 3 — substate hint that decorates `@cl_state` tag
 *  (`wait` / `compacting` / `retry 3` / `interrupted`). Set par les
 *  callers legacy `setTmuxStatus(name, status, info)` (= maintenant
 *  wrappers thin sur ce setter). Empty string normalisé à null. */
export function setIpcStateTagInfo(info: string | null): void {
    state.stateTagInfo = info && info.length > 0 ? info : null;
    notifyIpcChanged();
}

/** #862 Slice 2 — store the `@cl_counts` ground truth in ipcState so
 *  the BarRenderer observer can pickup. `null` = clear segment ;
 *  named counters can be partially null (= absent from the segment). */
export function setIpcCounters(
    counters: { open?: number | null; backlog?: number | null; events?: number | null } | null,
): void {
    if (counters === null) {
        state.counters = null;
    } else {
        state.counters = {
            open: counters.open ?? null,
            backlog: counters.backlog ?? null,
            events: counters.events ?? null,
        };
    }
    notifyIpcChanged();
}

/** #734 V3 Phase A — set AFK in-memory state. Called by the
 *  `Afk*ViaService` helpers right after they mutate the AfkService
 *  observable. Pass `mode=null` to reset the in-memory signal (the
 *  read path then falls back to the file ; do this only in tests).
 *  Production code uses `setIpcAfk("off"|"wait_10m"|"wait_inf", …)`
 *  to record an explicit AFK state. */
export function setIpcAfk(
    mode: "off" | "wait_10m" | "wait_inf" | null,
    expiryMs: number | null,
): void {
    state.afkMode = mode;
    state.afkExpiryMs = mode === "wait_10m" ? expiryMs : null;
    notifyIpcChanged();
}

/** #751 htwguc qb7zs6 — set `dispAfk` (la valeur AFK à afficher pendant
 *  la fenêtre debounce du toggle F9). Pass `null` to clear and converge
 *  back to `afk`. The bus emits `dispAfkChanged` when this couple
 *  changes between two consecutive `readLoopStateInput` calls — the
 *  chip painter subscribes for an instant repaint.
 *  No stash field — the `qb7zs6` semantic is that a cycle ending on the
 *  same kind as committed is a true noop (= timer stays). */
export function setIpcDispAfk(
    pending: {
        mode: "off" | "wait_10m" | "wait_inf";
        expiryMs: number | null;
        commitAtMs: number;
    } | null,
): void {
    if (pending === null) {
        state.dispAfkMode = null;
        state.dispAfkExpiryMs = null;
        state.dispAfkCommitAtMs = null;
        notifyIpcChanged();
        return;
    }
    state.dispAfkMode = pending.mode;
    state.dispAfkExpiryMs = pending.expiryMs;
    state.dispAfkCommitAtMs = pending.commitAtMs;
    notifyIpcChanged();
}

/** Convenience read of the dispAfk couple. Returns null when no pending
 *  is in flight (= chip should render `afk` directly). */
export function getIpcDispAfk(): {
    mode: "off" | "wait_10m" | "wait_inf";
    expiryMs: number | null;
    commitAtMs: number;
} | null {
    if (state.dispAfkMode === null || state.dispAfkCommitAtMs === null) return null;
    return {
        mode: state.dispAfkMode,
        expiryMs: state.dispAfkExpiryMs,
        commitAtMs: state.dispAfkCommitAtMs,
    };
}

/** #734 V3 Phase B — set last typing timestamp in-memory. Called by
 *  the dispatcher on `keystroke:typing` events. `null` resets the
 *  in-memory signal (read path falls back to the file mtime). */
export function setIpcHumanTypingAtMs(atMs: number | null): void {
    state.humanTypingAtMs = atMs;
    notifyIpcChanged();
}

/** #733 V2 — pane state setters, called by the matching `setPane*` in
 *  `state.ts` right before the file write. The reader (`readLoopStateInput`,
 *  `paneInterrupted`) consults these first ; `null` (default) means
 *  "no in-memory signal yet" and triggers the file fallback. */
export function setIpcPaneBusy(value: boolean | null): void {
    state.paneBusy = value;
    notifyIpcChanged();
}
export function setIpcPaneReady(value: boolean | null): void {
    state.paneReady = value;
    notifyIpcChanged();
}
export function setIpcPaneCompacting(value: boolean | null): void {
    state.paneCompacting = value;
    notifyIpcChanged();
}
export function setIpcPaneInterrupted(value: boolean | null): void {
    state.paneInterrupted = value;
    notifyIpcChanged();
}
export function setIpcPaneResuming(value: boolean | null): void {
    state.paneResuming = value;
    notifyIpcChanged();
}

/** Reset every field to the as-launched defaults. Tests only. */
export function resetIpcStateForTests(): void {
    state.bootComplete = null;
    state.loopStart = false;
    state.idleSinceMs = null;
    state.nextWakeAtMs = null;
    state.idleSinceCleared = false;
    state.busyDeferUntilMs = null;
    state.resumeSessionPickerActive = null;
    state.resumeModePickerActive = null;
    state.lastOpenWakeHash = null;
    state.drainedState = null;
    state.lastWakeHint = null;
    state.lastWakeAtMs = null;
    state.wakeInFlightAtMs = null;
    state.wakeRequestedAtMs = null;
    state.afkMode = null;
    state.afkExpiryMs = null;
    state.dispAfkMode = null;
    state.dispAfkExpiryMs = null;
    state.dispAfkCommitAtMs = null;
    state.humanTypingAtMs = null;
    state.paneBusy = null;
    state.paneReady = null;
    state.paneCompacting = null;
    state.paneInterrupted = null;
    state.paneResuming = null;
    state.lastViewPushAtMs = null;
    state.lastSseEventAtMs = null;
    state.sseConnected = null;
    state.bootDeadlineMs = null;
    state.counters = null;
    state.stateTagInfo = null;
}
