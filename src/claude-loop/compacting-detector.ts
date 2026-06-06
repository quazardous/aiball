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
 * Stateful detector with a latch. `detect()` returns the LATCHED state:
 * once a positive sighting lands, subsequent calls keep returning true
 * for `latchGraceMs` even if the raw classifier flips to false (frame
 * race, redraw, transient layout). Resets the latch on the next positive
 * sighting (so the grace clock starts from the LAST positive, not from
 * boot start).
 */
export class CompactingDetector {
    private lastPositiveMs: number | null = null;
    private readonly opts: Required<CompactingDetectorOptions>;

    constructor(opts: CompactingDetectorOptions = {}) {
        this.opts = { ...DEFAULT_OPTS, ...opts };
    }

    detect(paneText: string, ctx: CompactingDetectorCtx = {}): boolean {
        const now = ctx.nowMs ?? Date.now();
        const raw = classifyCompacting(paneText, ctx, this.opts);
        if (raw) {
            this.lastPositiveMs = now;
            return true;
        }
        if (this.lastPositiveMs !== null && (now - this.lastPositiveMs) < this.opts.latchGraceMs) {
            return true;
        }
        return false;
    }

    /** Reset the latch — tests, or explicit out-of-band knowledge that
     *  the compact really ended (e.g. a user-typed turn after compact). */
    reset(): void {
        this.lastPositiveMs = null;
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
