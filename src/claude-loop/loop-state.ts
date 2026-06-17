/**
 * #627 — central state-machine for claude-loop's visual + behavioural surface.
 *
 * Replaces the scattered if/else trees in state.ts, timer.ts,
 * session-start-hook.ts, pty-proxy.py with a single pure function. Inputs
 * are explicit (timestamps + file-derived booleans), output is a fully
 * computed view that every consumer paints / gates against.
 *
 * Hand-rolled lightweight FSM (david's `<latest>` : "ou en refaire une
 * légère"). No external dep. Three parallel dimensions :
 *
 *   1. PHASE   : boot → idle / busy (bar BG)
 *   2. AFK     : off (autonomous loop) / wait-10m (auto-release) /
 *                wait-inf (held by F9)
 *   3. TYPING  : human-typing-now (5s TTL) / not
 *
 * Each consumer reads files / env once, hands them to `computeLoopView`,
 * and uses the result. Tests inject scenarios directly — no fs, no
 * sleeping, no actual loop running.
 */

/** Logical AFK mode derived from the AFK file content + clock. */
export type AfkMode = "off" | "wait_10m" | "wait_inf";

/** All inputs to the state computation. Caller-provided ; the service is
 *  pure (no fs, no `Date.now`). Pass `null` for "no marker / unknown". */
export interface LoopStateInput {
    /** Current time in ms-since-epoch. */
    nowMs: number;
    /** ms-since-epoch when the loop session started. */
    loopStartMs: number;
    /** Boot-grace safety cap in ms (the `boot-complete` signal is the
     *  authoritative end-of-boot ; this cap fires only as a fail-safe
     *  for crashed hooks). Typically 300_000 (5 min). */
    bootGraceMs: number;
    /** #629 david `2hwuan` : floor INVIOLABLE — boot phase ne peut PAS
     *  finir avant `loopStartMs + bootMinMs`. Aucun signal externe
     *  (bootComplete du hook, paneReady, etc.) ne peut court-circuiter
     *  ce minimum. Couvre le flicker `loop`/`boot` au démarrage où des
     *  hooks early peuvent prétendre que claude est ready avant qu'il
     *  ait vraiment dessiné le prompt. Typiquement 30_000 (30 s). */
    bootMinMs: number;
    /** #624 david `8pwvm3` : true while the Claude Code resume picker is
     *  on screen (set by `setResumePicker(true)` from `session-start-hook`).
     *  Stretches the boot phase indefinitely — users can take their time
     *  picking a session without the bar flipping out of `[boot]`. */
    resumePickerActive: boolean;
    /** #624 david `8pwvm3` : true once `session-start-hook` has signalled
     *  `setResumePicker(false)` (claude is past the picker / loading).
     *  Authoritative end-of-boot signal. */
    bootComplete: boolean;
    /** #872 / #870 — watcher-driven seal deadline (ms-since-epoch).
     *  Pushed to `now + 10s` by each pane watcher tick observing a
     *  "still booting" condition. `isInBootGrace` consults this directly :
     *  active iff `nowMs < bootDeadlineMs`. Null pre-actor-init. */
    bootDeadlineMs: number | null;
    /** True when launched with `--no-wait` (eager drain). */
    noWait: boolean;

    /** mtime of `human-typing` marker (ms-since-epoch), or null. */
    humanTypingAtMs: number | null;
    /** TTL for the human-typing marker in ms (typically 5_000). */
    humanTypingTtlMs: number;

    /** AFK file mode + auto-release expiry — COMMITTED value (= the
     *  gate-logic truth). `expiryMs` is meaningful only in `wait_10m` ;
     *  ignored for `off` and `wait_inf`. Bar word, AFK SM, wake gate
     *  and countdown all consume these — they stay stable during the
     *  3s debounce window so an F9 cycle under 3s is a noop for the SM. */
    afkMode: AfkMode;
    afkExpiryMs: number | null;
    /** #751 htwguc — `dispAfk` : display-only AFK state for the bar's
     *  right-side chip. Diverges from `afkMode` during the 3s debounce
     *  window of a toggle (= visual feedback instant), converges back
     *  after the commit. `null` when no pending is in flight (= chip
     *  renders `afkMode` directly). The bus emits `dispAfkChanged` when
     *  this couple changes ; the chip painter subscribes for an
     *  instant repaint. Optional so older / hand-crafted inputs default
     *  to converged. ONLY `renderAfkChunk` is allowed to consume these. */
    dispAfkMode?: AfkMode | null;
    dispAfkExpiryMs?: number | null;
    /** ms-since-epoch when the pending will converge to `afk`. Read by
     *  the timer's commit tick to decide when to flush via the *ViaService
     *  helpers. */
    dispAfkCommitAtMs?: number | null;

    /** mtime of `idle-since` marker (ms-since-epoch), or null. */
    idleSinceMs: number | null;
    /** mtime of `wake-in-flight` marker (ms-since-epoch), or null. */
    wakeInFlightAtMs: number | null;
    /** TTL for wake-in-flight before it's considered stale (typically 2_000). */
    wakeInFlightTtlMs: number;
    /** Absolute deadline (ms-since-epoch) at which busy-defer expires.
     *  `null` = no defer set. Past-now = defer expired (treated as null). */
    busyDeferUntilMs: number | null;

    /** #624 david `62ys4g` : pane-* signals are external (claude TUI
     *  drives them) so the state machine treats them as marker-backed
     *  inputs like every other signal. Setters live in `state.ts`
     *  (`setPaneBusy`, `setPaneReady`, `setCompacting`, `setInterrupted`).
     *
     *  - `paneBusy`     : `esc to interrupt` visible in the footer
     *  - `paneReady`    : prompt signature (`Claude Code v`, `❯ `, …)
     *  - `paneCompacting`: `/compact` or auto-compact running
     *  - `paneInterrupted`: `interrupted by user` notice in pane */
    paneBusy: boolean;
    paneReady: boolean;
    paneCompacting: boolean;
    paneInterrupted: boolean;

    /** #722 — TTL for the input-hot observable. A keystroke is « hot »
     *  if it landed within this window (typically 3_000ms). Drives the
     *  pane-probe cadence via `shouldPollFast`. */
    inputHotTtlMs: number;

    /** True when this tryWake invocation was manually requested (file
     *  marker bypass) — skips most gates (boot, user-grace, AFK, defer). */
    manualWake?: boolean;
}

/** Bar BG state (drives `setTmuxStatus` color). */
// #715 V2 — bar rendering types live in `bar-render.ts` now ; re-exported
// here for back-compat so external imports of `Phase` / `Presence` /
// `AfkChunk` from `loop-state.js` keep working without a churning diff.
export type { Phase, Presence, AfkChunk } from "./bar-render.js";
import type { Phase, Presence, AfkChunk } from "./bar-render.js";
import { renderAfkChunk, renderBarBg, derivePresence } from "./bar-render.js";

/** Fully computed view of the loop. Every consumer paints / gates from this. */
export interface LoopStateView {
    /** Bar BG. */
    phase: Phase;
    /** Human presence in the loop (renamed from `barWord` in #954). */
    presence: Presence;
    /** Status-right AFK segment. */
    afkChunk: AfkChunk;
    /** True iff `tryWake` should proceed. False is paired with a reason. */
    wakeAllowed: boolean;
    /** Single-line skip reason when `wakeAllowed` is false. Null when allowed. */
    wakeSkipReason: string | null;
    /** True while boot-grace is still running (claude may not even be
     *  at the prompt yet). Consumers use this to skip bar BG flips,
     *  AFK arming on typing, and probe overrides. */
    inBootGrace: boolean;
    // #840 Slice A (#766) — raw state surfaced on the pushed view so
    // out-of-process consumers (proxy via WS push, hooks via UDS query)
    // can decide without reading shadow files. Phase C drops the shadow
    // files once these fields are everywhere.
    /** Committed AFK mode. `dispAfkMode` is intentionally NOT pushed —
     *  the pending state is a local pre-commit UI detail of the timer. */
    afkMode: AfkMode;
    /** Absolute expiry ms-since-epoch for `wait_10m`, null otherwise. */
    afkExpiryMs: number | null;
    /** True once the timer has sealed the boot phase. */
    bootComplete: boolean;
    /** Absolute deadline (ms-since-epoch) of an active busy-defer ; null
     *  if none. Past-now is treated as null by consumers. */
    busyDeferUntilMs: number | null;
}

// ---------------------------------------------------------------------------
//  Internal helpers — small, composable, testable.
// ---------------------------------------------------------------------------

export function isInBootGrace(input: LoopStateInput): boolean {
    // #872 / #870 Phase 2 — modèle final unifié :
    //
    //   1. FLOOR INVIOLABLE : pendant `bootMinMs` (typ. 30 s), rien
    //      n'autorise à quitter boot — pas même `bootComplete` (couvre
    //      le flicker des hooks early qui claim ready avant que le
    //      prompt soit dessiné).
    //   2. `bootComplete` marker = boot a SETTLED une fois ; on n'y
    //      retourne JAMAIS post-floor.
    //   3. `bootDeadlineMs` (watcher-driven deadline) = source d'autorité
    //      principale post-floor. Les watchers pane (refreshPaneMarkers
    //      → bootMachine actor → WATCHER_TICK) pushent à `now+10s` tant
    //      qu'une condition de boot est observée.
    //   4. Fallback : si `bootDeadlineMs` est null (actor pas encore
    //      wired, tests pure), on retombe sur le simple `nowMs >= bootMinMs`.
    const elapsed = input.nowMs - input.loopStartMs;
    if (input.bootMinMs > 0 && elapsed < input.bootMinMs) return true;
    if (input.bootComplete) return false;
    if (input.bootDeadlineMs !== null) return input.nowMs < input.bootDeadlineMs;
    return false;
}

export function isTypingNow(input: LoopStateInput): boolean {
    if (input.humanTypingAtMs === null) return false;
    return (input.nowMs - input.humanTypingAtMs) < input.humanTypingTtlMs;
}

function isBusyDeferActive(input: LoopStateInput): boolean {
    if (input.busyDeferUntilMs === null) return false;
    return input.busyDeferUntilMs > input.nowMs;
}

/** True iff a NOT-AFK hold is active = the human declared **PRESENT** (held
 *  the loop). #977 — renamed from the misleading `isAfkActive` : the value is
 *  `human present`, NOT `human away`. `wait_10m` past its expiry counts as
 *  `off` (auto-released → away/autonomous). */
export function isHumanPresentHold(input: LoopStateInput): boolean {
    if (input.afkMode === "off") return false;
    if (input.afkMode === "wait_inf") return true;
    // wait_10m : honor the expiry timestamp.
    if (input.afkExpiryMs === null) return false;
    return input.afkExpiryMs > input.nowMs;
}

// #715 V2 — `computePhase` / `computeBarWord` / `computeAfkChunk` +
// `formatCountdown` moved to `bar-render.ts`. `effectiveAfkMode` stays
// here because the bus + the wake gate also consult it.

/** Effective AFK mode after honoring the 10m auto-release. Re-used by
 *  the bar-render layer (`bar-render.ts`). */
export function effectiveAfkMode(input: LoopStateInput): AfkMode {
    if (input.afkMode === "wait_10m" && input.afkExpiryMs !== null && input.afkExpiryMs <= input.nowMs) {
        return "off";
    }
    return input.afkMode;
}

/** Gate the wake. Manual wakes skip almost every check (file-marker bypass).
 *  Order matters for the log reason ; the first failing gate wins. */
function computeWakeGate(input: LoopStateInput): { allowed: boolean; reason: string | null } {
    const manual = input.manualWake === true;

    // The idle-since gate is the only one a manual wake honors (pinging
    // over a busy claude is always wrong).
    if (input.idleSinceMs === null) {
        return { allowed: false, reason: "no idle marker (claude busy or boot grace not yet elapsed)" };
    }
    if (manual) return { allowed: true, reason: null };

    if (isInBootGrace(input)) {
        // #629 — boot peut être actif pour 3 raisons distinctes (floor /
        // stretches / time cap), chacune avec une trace utile.
        const elapsed = input.nowMs - input.loopStartMs;
        if (input.bootMinMs > 0 && elapsed < input.bootMinMs) {
            const leftS = Math.ceil((input.bootMinMs - elapsed) / 1000);
            return { allowed: false, reason: `boot floor ${leftS}s left (inviolable)` };
        }
        if (input.resumePickerActive) return { allowed: false, reason: "boot stretched by resume picker" };
        if (input.paneCompacting)     return { allowed: false, reason: "boot stretched by /compact" };
        if (!input.paneReady)         return { allowed: false, reason: "boot — claude prompt not yet visible" };
        return { allowed: false, reason: "boot phase (safety cap)" };
    }
    if (isTypingNow(input)) {
        return { allowed: false, reason: "human typing right now" };
    }
    if (isHumanPresentHold(input)) {
        // #745 phase A : the user-grace check that lived right above was
        // a strict duplicate of this AFK check. Typing arms NOT AFK 10m
        // via the proxy → AfkService → AFK SM, with the same 600s TTL
        // as user-grace did. Removed — AFK is the single source of truth.
        return { allowed: false, reason: "NOT AFK hold active (10m countdown or ∞, F9 to release)" };
    }
    if (isBusyDeferActive(input)) {
        const remMs = (input.busyDeferUntilMs ?? input.nowMs) - input.nowMs;
        return { allowed: false, reason: `busy-defer ${remMs}ms remaining` };
    }
    if (input.paneBusy) {
        return { allowed: false, reason: "pane footer shows `esc to interrupt`" };
    }
    if (input.paneCompacting) {
        // #624 david `62ys4g` : `/compact` (manual or auto) is internally
        // busy ; firing a wake on top of it loses the wake to the
        // compaction's pending prompt.
        return { allowed: false, reason: "pane shows /compact (claude is internally busy)" };
    }
    return { allowed: true, reason: null };
}

/**
 * Reduce every input dimension to the single LoopStateView consumers
 * paint / gate against. Pure function — no fs, no `Date.now`, no side
 * effects. Tests inject scenarios directly.
 */
export function computeLoopView(input: LoopStateInput): LoopStateView {
    const phase = renderBarBg(input);
    const presence = derivePresence(input);
    const afkChunk = renderAfkChunk(input);
    const gate = computeWakeGate(input);
    return {
        phase,
        presence,
        afkChunk,
        wakeAllowed: gate.allowed,
        wakeSkipReason: gate.reason,
        inBootGrace: isInBootGrace(input),
        // #840 Slice A — raw state for out-of-process consumers.
        afkMode: input.afkMode,
        afkExpiryMs: input.afkExpiryMs,
        bootComplete: input.bootComplete,
        busyDeferUntilMs: input.busyDeferUntilMs,
    };
}

// ---------------------------------------------------------------------------
//  Semantic helpers (#627 david `vnhdku` "ajoute aussi des helper semantique,
//  des canCeci ou canCela") — intent-shaped questions the consumers ASK
//  instead of recomputing from view fields. They take either the raw input
//  (for the consumers that need pre-view answers, like the proxy typing
//  branch) or the computed view (for the consumers painting/gating).
// ---------------------------------------------------------------------------

/** True iff a typing keystroke should arm/refresh the NOT AFK 10m hold.
 *  Skipped during boot-grace (resume-picker typing) and in NOT AFK ∞
 *  (only F9 releases the indefinite hold). */
export function canArmAfk10mOnTyping(input: LoopStateInput): boolean {
    if (isInBootGrace(input)) return false;
    if (effectiveAfkMode(input) === "wait_inf") return false;
    return true;
}

/** True iff a typing keystroke should paint the bar word `stop` (red).
 *  Skipped during boot-grace (the `boot` word stays put). */
export function canPaintStopOnTyping(input: LoopStateInput): boolean {
    return !isInBootGrace(input);
}

/** True iff the session-start hook / pane probe is allowed to flip the
 *  bar BG out of `[boot]`. False during boot-grace — settleBoot is the
 *  single authority for that transition. */
export function canFlipBgFromBoot(input: LoopStateInput): boolean {
    return !isInBootGrace(input);
}

/** True iff `settleBoot` should arm NOT AFK 10m at the boot-grace
 *  transition. Driven by the launch mode (--wait arms, --no-wait skips). */
export function shouldArmAfk10mOnSettleBoot(input: Pick<LoopStateInput, "noWait">): boolean {
    return !input.noWait;
}

/** Alias for the view's `wakeAllowed` — reads more naturally at call sites. */
export function canFireWake(view: LoopStateView): boolean {
    return view.wakeAllowed;
}

/** True iff the AFK chunk says `NOT AFK` (human is holding the loop,
 *  either via the 10m countdown or the ∞ hold). */
export function isAfkHeld(view: LoopStateView): boolean {
    return view.afkChunk.label === "NOT AFK";
}

/** True iff the loop is autonomous (bar word `loop`, AFK chunk dim). */
export function isAutonomous(view: LoopStateView): boolean {
    return view.presence === "loop";
}

/** True iff the bar is in the boot visual phase. Use this rather than
 *  comparing the word string at call sites — single source of truth. */
export function isBootPhase(view: LoopStateView): boolean {
    return view.phase === "boot";
}

/** True iff claude is REALLY busy : footer `esc to interrupt` visible
 *  OR `/compact` running. Canonical source for "claude is working" —
 *  consumed by the pane-probe (busy-gated 1s refresh) and any other
 *  subscriber that needs to know whether claude is mid-turn (#714).
 *
 *  #1014 — `paneBusy` is now the output of the composite busy decay-stack
 *  (turn ∨ esc ∨ compacting), so it already subsumes compacting ; the
 *  `|| paneCompacting` is kept as a belt-and-braces for any tick where the
 *  stack hasn't re-signalled the compacting proof yet. */
export function isReallyBusy(input: LoopStateInput): boolean {
    return input.paneBusy || input.paneCompacting;
}

/** #722 — Time elapsed (ms) since the last detected keystroke ; null
 *  if none has been observed yet. Pure « age » helper — consumers
 *  decide what to do with the number (compare to a threshold, log a
 *  debug line, drive a cadence, etc.). */
export function inputHotAgeMs(input: LoopStateInput): number | null {
    if (input.humanTypingAtMs === null) return null;
    return input.nowMs - input.humanTypingAtMs;
}

/** #722 — True iff a keystroke landed within the configured
 *  `inputHotTtlMs` window. Pure observable — orthogonal to phase /
 *  AFK / busy. Consumers pick it up via the SM bus and decide what it
 *  means (e.g. faster pane poll cadence, future input-vs-takeover
 *  nuances on V3 #716). */
export function isInputHot(input: LoopStateInput): boolean {
    const age = inputHotAgeMs(input);
    if (age === null) return false;
    return age < input.inputHotTtlMs;
}

/** #722 — Should the pane-probe run at FAST rate (vs SLOW)?
 *  Aggregates the business signals that justify a tighter poll:
 *  - boot phase (catch picker / resume transitions quickly)
 *  - claude busy (mid-turn state changes more often)
 *  - input-hot (recent keystroke → claude may react)
 *  OR semantics : any one says fast. Single composition site so a
 *  future gate (e.g. error backoff transient) just adds one branch
 *  without rewiring every consumer. */
export function shouldPollFast(input: LoopStateInput): boolean {
    if (isInBootGrace(input)) return true;
    if (isReallyBusy(input)) return true;
    if (isInputHot(input)) return true;
    return false;
}

// ---------------------------------------------------------------------------
//  #630 david `e4ejra` — LoopStateBus
//
//  Pure compute stays pure ; the bus is the LAYER above. It owns the last
//  view, diffs against the next, and emits typed events. Consumers
//  subscribe instead of polling — fewer redundant repaints, richer
//  transition logs.
// ---------------------------------------------------------------------------

/** Typed event map. Consumer code uses `bus.on("event", cb)` ; TypeScript
 *  infers the callback signature from this map. */
export type LoopStateEvents = {
    /** Fired whenever the view changes at all (any field). Always fires
     *  before the typed events below. */
    transition: (prev: LoopStateView, next: LoopStateView) => void;
    /** #722 — `shouldPollFast(input)` flipped. `next=true` = at least
     *  one of boot / busy / input-hot is true ; pane-probe should run
     *  at `pane_probe_fast_ms`. `next=false` = back to slow. Timer's
     *  pane-probe subscribes here to re-arm its setInterval. */
    pollFast: (next: boolean, prev: boolean) => void;
    /** #751 htwguc — `dispAfk` couple changed between two consecutive
     *  inputs (toggle F9, commit, or convergence to null). The chip
     *  painter subscribes for an instant repaint. */
    dispAfkChanged: (next: { mode: AfkMode | null; expiryMs: number | null; commitAtMs: number | null }) => void;
};

type AnyListener = (...args: unknown[]) => void;
type EventListeners = Record<string, AnyListener[] | undefined>;

/** Stateful wrapper around `computeLoopView` — maintains the last view +
 *  emits diffs. Pure-compute stays pure ; bus is the layer above. */
export class LoopStateBus {
    private lastView: LoopStateView | null = null;
    private lastInput: LoopStateInput | null = null;
    private listeners: EventListeners = {};

    /** Subscribe to an event. Returns an unsubscribe function. */
    on<K extends keyof LoopStateEvents>(event: K, cb: LoopStateEvents[K]): () => void {
        const list = (this.listeners[event] ||= []) as AnyListener[];
        list.push(cb as unknown as AnyListener);
        return () => {
            const i = list.indexOf(cb as unknown as AnyListener);
            if (i >= 0) list.splice(i, 1);
        };
    }

    /** Current view (last computed). Null until the first `update`. */
    current(): LoopStateView | null {
        return this.lastView;
    }

    /** Recompute the view from `input`, diff against the last, emit
     *  events for every transition. Returns the new view.
     *
     *  #714 — first-update behaviour : when there is no previous view yet,
     *  the historical contract was « stay silent ». That left the `busy`
     *  consumer (pane-probe cadence) stuck if the very first input was
     *  already busy (paneBusy/paneCompacting set at boot end). We now emit
     *  the `busy` event on the first update IF `isReallyBusy(input)===true`,
     *  treating the missing prior state as « not busy » — the consumer
     *  arms correctly. Other diffs stay silent on first update (no real
     *  transition information). */
    update(input: LoopStateInput): LoopStateView {
        const next = computeLoopView(input);
        if (this.lastView !== null && this.lastInput !== null) {
            this.emitDiffs(this.lastView, next, this.lastInput, input);
        } else {
            // First update : treat the missing prior state as "all false"
            // for poll-fast so consumers re-arm if claude is already
            // boot/busy/input-hot on boot. (#888 — busy/inputHot retirés
            // car remplacés par TurnController/TypingController emits ;
            // ces controllers émettent leur état initial à start.)
            if (shouldPollFast(input)) this.emit("pollFast", true, false);
        }
        this.lastView = next;
        this.lastInput = input;
        return next;
    }

    private emitDiffs(prev: LoopStateView, next: LoopStateView, prevInput: LoopStateInput, nextInput: LoopStateInput): void {
        const changed = JSON.stringify(prev) !== JSON.stringify(next);
        if (changed) this.emit("transition", prev, next);
        // #888 — `busy` emit retiré : remplacé par TurnController
        // turn_started/turn_ended emits. `inputHot` emit retiré :
        // remplacé par TypingController typing:started/typing:ended.
        // #722 — aggregated poll-rate decision (boot / busy / input-hot).
        // Subscribers (timer.ts pane-probe) re-arm their setInterval to
        // the fast vs slow ms on transition.
        const prevFast = shouldPollFast(prevInput);
        const nextFast = shouldPollFast(nextInput);
        if (prevFast !== nextFast) this.emit("pollFast", nextFast, prevFast);
        // #872 Phase 3 + #877 Slice A — `bootEnded`/`bootStarted` ET
        //   `afkArmed10m`/`afkArmedInf`/`afkCleared` retirés. Les BootMachine
        //   et AfkMachine acteurs (cf. boot-machine.ts / afk-machine.ts) sont
        //   l'autorité unique sur ces "locus" events, émis via XState `emit`
        //   et consommés via `actor.on(<controller>:<event_name>, cb)`.
        //   Le bus garde la mécanique de diff pour les input-derived signals
        //   (busy, inputHot, pollFast, dispAfkChanged, picker, wake gates).
        // #888 — pickerOpened/Closed emits retirés : remplacés par
        // les watchers PaneWatcher direct (pickerSessionW/pickerModeW).
        // #751 htwguc — emit `dispAfkChanged` on any diff of the display
        // couple. Painters subscribe for an instant chip repaint.
        const prevDisp = prevInput.dispAfkMode ?? null;
        const nextDisp = nextInput.dispAfkMode ?? null;
        const prevDispExp = prevInput.dispAfkExpiryMs ?? null;
        const nextDispExp = nextInput.dispAfkExpiryMs ?? null;
        if (prevDisp !== nextDisp || prevDispExp !== nextDispExp) {
            this.emit("dispAfkChanged", {
                mode: nextDisp,
                expiryMs: nextDispExp,
                commitAtMs: nextInput.dispAfkCommitAtMs ?? null,
            });
        }
    }

    private emit<K extends keyof LoopStateEvents>(event: K, ...args: Parameters<LoopStateEvents[K]>): void {
        const list = this.listeners[event];
        if (!list) return;
        for (const cb of list) {
            try {
                cb(...args);
            } catch { /* listener throws are swallowed — never break the bus */ }
        }
    }
}

// #1014 — `nextPaneBusy` (the #890/#992/#994 esc arm/dearm latch) is retired.
// `paneBusy` is now the output of the composite busy decay-stack (busy-stack.ts,
// driven in loop.ts:refreshPaneMarkers) : the remanence gives the latch's
// hysteresis for free and a turn reinforces a flickering pane. The esc/pane-idle
// arm/dearm semantics moved there (esc-visible → seenProof(esc) ; pane-idle →
// releaseAll).
