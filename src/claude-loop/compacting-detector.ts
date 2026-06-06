/**
 * #843 — Unified compacting-state detector.
 *
 * Was: `classifyPaneSpecial` in state.ts owned the regex + footer scope ;
 * the timer's `refreshPaneMarkers` set `paneCompacting` from `snap.special`
 * verbatim ; AND `pickerOrTransient` had a SECOND, GLOBAL `Compacting
 * conversation` regex on the whole pane. Two divergent detection paths +
 * a too-tight 5-line footer scope produced two reported failure modes:
 *
 *   1. Live `/compact` only matched while the auto-mode banner happened
 *      to carry `You've used NN% of your weekly limit` (false-positive
 *      `%` in the footer). The real progress bar (`▰▱` + `27%`) sits ~6
 *      non-empty lines above the prompt — past the 5-line slice. When
 *      the weekly-limit banner went away, detection dropped mid-compact
 *      → bar suffix flapped `[boot:compacting]` → `[boot]` → … even
 *      though the compact was still running.
 *
 *   2. Stale `Compacting conversation` text lingering in scrollback kept
 *      `pickerOrTransient`'s GLOBAL regex matching for ever → `paneReady`
 *      stayed false → boot never sealed.
 *
 * This module unifies both into ONE source of truth + ONE knob, with two
 * fixes baked in:
 *
 *   - Wider default footer (`footerLines: 12`, `bootFooterLines: 18`) so
 *     the `▰▱` progress bar is reliably inside the scope across Claude
 *     UI layouts. `ctx.isBoot` lets the boot phase use a wider window
 *     (initial resume-compact has a slightly different render).
 *
 *   - `%` live-signal scoped to `\d+%\s*$` (end of line) so the
 *     `88% of your weekly limit` flavour stops counting. Progress bar
 *     alone is enough; `%` is supplementary.
 *
 *   - A latch: once `detect()` returns true, it stays true for
 *     `latchGraceMs` (default 10 s) even if the raw classifier briefly
 *     flips to false (claude redraws, the bar moves out of footer for
 *     one probe, etc.). david `(#843)`: "il faut prolonger la phase
 *     compacting".
 *
 * Two public surfaces:
 *
 *   - `classifyCompacting(text, ctx)` — PURE raw classifier (no latch).
 *     Used by the short-lived hooks + `snapshotPane`.
 *
 *   - `CompactingDetector` (+ module singleton `getCompactingDetector`)
 *     — stateful latch. Used by the timer's long-lived process so the
 *     IPC `paneCompacting` flag absorbs the flicker.
 */

import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./pane-watchers/types.js";

export interface CompactingDetectorCtx {
    /** True iff the caller is in boot phase. Detection widens the footer
     *  scope (`bootFooterLines`) because the initial resume-compact has
     *  a different render than a user-typed `/compact`. */
    isBoot?: boolean;
    /** Now-ms, for the latch grace window. Defaults to `Date.now()`. */
    nowMs?: number;
}

export interface CompactingDetectorOptions {
    /** Grace ms before flipping false after the last positive detection.
     *  Default 10_000. Absorbs the flap when claude redraws and the
     *  progress bar briefly leaves the footer scope. */
    latchGraceMs?: number;
    /** Non-empty-line slice depth for the live-signal scan (post-boot).
     *  Default 12 — covers the `▰▱` bar that sits 5-7 non-empty lines
     *  above the prompt (bloc `prompt + 2 separators + auto-mode footer`
     *  eats 5 lines on its own). */
    footerLines?: number;
    /** Same but during boot. Default 18 — wider because the initial
     *  resume-compact render can differ slightly. */
    bootFooterLines?: number;
}

const DEFAULT_OPTS: Required<CompactingDetectorOptions> = {
    latchGraceMs: 10_000,
    footerLines: 12,
    bootFooterLines: 18,
};

/**
 * PURE raw classifier — returns true iff the pane currently shows a live
 * `/compact` (or `/summarize`) screen. No state, no latch.
 *
 * Rule (kept simple, capture-validated, #843):
 *   - Anywhere in pane: `Compacting conversation` OR `Summarizing the conversation`.
 *   - In the footer slice (last N non-empty lines):
 *       progress bar `▰▱`  OR  end-of-line `\d+%` (Claude's compact format).
 *
 * `\d+%` is anchored at end-of-line so the auto-mode banner's
 * `88% of your weekly limit · resets …` stops triggering (the `%` is
 * mid-line). The compact's own `▰▱…▰ 27%` IS end-of-line.
 */
export function classifyCompacting(
    paneText: string,
    ctx: CompactingDetectorCtx = {},
    opts: CompactingDetectorOptions = {},
): boolean {
    const merged = { ...DEFAULT_OPTS, ...opts };
    const n = ctx.isBoot ? merged.bootFooterLines : merged.footerLines;
    const footer = paneText
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-n)
        .join("\n");
    const hasText = /Compacting conversation|Summarizing the conversation/i.test(paneText);
    if (!hasText) return false;
    const hasProgressBar = /[▰▱]/.test(footer);
    const hasEolPercent = /\d+\s?%\s*$/m.test(footer);
    return hasProgressBar || hasEolPercent;
}

/**
 * Compacting state surfaced by the watcher. `active=true` while the
 * latch holds (during a real compact + the grace window after the raw
 * signal disappears). Future revisions can add a `percent` field when
 * we want to expose the progress to subscribers — for now the shape is
 * minimal.
 */
export interface CompactingState {
    active: boolean;
}

/**
 * Stateful detector with a latch + `PaneWatcher<CompactingState>`
 * surface (#845). `detect()` (legacy) returns the LATCHED boolean ;
 * `observe()` returns the typed `CompactingState` and emits
 * `change/begin/end` events on transitions. Both share the same internal
 * latch so the orchestrator can consume EITHER surface without
 * double-stateful weirdness.
 *
 * Latch contract : once a positive sighting lands, subsequent calls keep
 * returning `active=true` for `latchGraceMs` even if the raw classifier
 * flips to false (frame race, redraw, transient layout). The grace clock
 * resets on each new positive (= continuous compact extends the hold
 * naturally).
 */
export class CompactingDetector implements PaneWatcher<CompactingState> {
    readonly name = "compacting";
    private lastPositiveMs: number | null = null;
    private state: CompactingState = { active: false };
    private listeners: {
        change: Array<(next: CompactingState, prev: CompactingState | null) => void>;
        begin: Array<(s: CompactingState) => void>;
        end: Array<(s: CompactingState) => void>;
        progress: Array<(s: CompactingState) => void>;
    } = { change: [], begin: [], end: [], progress: [] };
    private readonly opts: Required<CompactingDetectorOptions>;

    constructor(opts: CompactingDetectorOptions = {}) {
        this.opts = { ...DEFAULT_OPTS, ...opts };
    }

    /** Legacy boolean surface — kept so existing callers (timer.ts
     *  refreshPaneMarkers) keep working until they migrate to `observe`
     *  + subscriptions. Calls into the same latch state as `observe`. */
    detect(paneText: string, ctx: CompactingDetectorCtx = {}): boolean {
        return this.observe(paneText, { nowMs: ctx.nowMs ?? Date.now(), isBoot: ctx.isBoot }).active;
    }

    /** PaneWatcher contract : pure transform pane → state, with event
     *  emission on transitions. `ctx.isBoot` (carried on PaneScanCtx)
     *  widens the footer scope during boot. */
    observe(paneText: string, ctx: PaneScanCtx): CompactingState {
        const now = ctx.nowMs;
        const raw = classifyCompacting(paneText, { isBoot: ctx.isBoot, nowMs: now }, this.opts);
        let nextActive: boolean;
        if (raw) {
            this.lastPositiveMs = now;
            nextActive = true;
        } else {
            nextActive =
                this.lastPositiveMs !== null
                && (now - this.lastPositiveMs) < this.opts.latchGraceMs;
        }
        const prev = this.state;
        const next: CompactingState = { active: nextActive };
        if (prev.active === next.active) return next; // no transition
        this.state = next;
        this.emitChange(next, prev);
        if (!prev.active && next.active) this.emitBegin(next);
        if (prev.active && !next.active) this.emitEnd(next);
        return next;
    }

    snapshot(): CompactingState {
        return this.state;
    }

    on<E extends keyof PaneWatcherEvents<CompactingState>>(
        event: E,
        cb: NonNullable<PaneWatcherEvents<CompactingState>[E]>,
    ): () => void {
        const list = this.listeners[event as keyof typeof this.listeners];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (list as Array<any>).push(cb);
        return () => {
            const idx = list.indexOf(cb as never);
            if (idx >= 0) list.splice(idx, 1);
        };
    }

    /** Drop the latch + listeners. Used at boot for a clean slate, or
     *  on explicit out-of-band knowledge that the compact really ended. */
    reset(): void {
        this.lastPositiveMs = null;
        this.state = { active: false };
        this.listeners = { change: [], begin: [], end: [], progress: [] };
    }

    private emitChange(next: CompactingState, prev: CompactingState): void {
        for (const cb of this.listeners.change) {
            try { cb(next, prev); } catch { /* listener isolation */ }
        }
    }
    private emitBegin(s: CompactingState): void {
        for (const cb of this.listeners.begin) {
            try { cb(s); } catch { /* listener isolation */ }
        }
    }
    private emitEnd(s: CompactingState): void {
        for (const cb of this.listeners.end) {
            try { cb(s); } catch { /* listener isolation */ }
        }
    }
}

/**
 * Footer-scoped detection of the transient `Compact this conversation?`
 * confirmation screen Claude shows right after a resume picker selection
 * (before the actual compact runs). Footer-scoped because the same string
 * could legitimately appear elsewhere (a help message, a slash-command
 * autocomplete) — we only want the actual takeover screen at the bottom.
 */
export function isCompactConfirmPrompt(paneText: string, footerLines = 12): boolean {
    const footer = paneText
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-footerLines)
        .join("\n");
    return /Compact this conversation\??/i.test(footer);
}

// Module-level singleton for the long-lived timer process. Hooks /
// short-lived subprocesses should call `classifyCompacting` directly
// (the latch needs a persistent process to mean anything).
let _singleton: CompactingDetector | null = null;
export function getCompactingDetector(): CompactingDetector {
    if (!_singleton) _singleton = new CompactingDetector();
    return _singleton;
}
export function resetCompactingDetectorForTests(): void {
    _singleton = new CompactingDetector();
}
