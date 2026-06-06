/**
 * #845 Phase B — Watchers active during the boot zone. All four
 * classify a visible/not-visible signal on the live pane and extend
 * `BoolWatcher` (begin/end events on transition).
 *
 * Regexes extracted from the inline `refreshPaneMarkers` in timer.ts ;
 * keep them as the ONLY source. If a regex needs updating, this file is
 * the place — the timer just delegates to `obs.tick()`.
 */

import { BoolWatcher } from "./bool-watcher.js";
import type { PaneScanCtx } from "./types.js";

/** Claude's first resume picker : the session-list screen.
 *  Match shape (from #647 `6e2uzf` regex) requires BOTH `Resume session`
 *  AND `Space to preview` so the splash header doesn't false-positive. */
export class PickerSessionWatcher extends BoolWatcher {
    readonly name = "pickerSession";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return /Resume session\b/i.test(paneText)
            && /Space to preview/i.test(paneText);
    }
}

/** Second picker : the resume-mode chooser (summary / as-is / abort). */
export class PickerModeWatcher extends BoolWatcher {
    readonly name = "pickerMode";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return /Resume from summary|Resume full session as-is|Don't ask me again/.test(paneText);
    }
}

/** `Resuming conversation…` transient — visible after picker dismiss
 *  but before claude lands at the prompt. Mutually exclusive with the
 *  pickers by construction (= already past them). */
export class ResumingWatcher extends BoolWatcher {
    readonly name = "resuming";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        if (!/Resuming conversation/i.test(paneText)) return false;
        // The session-start-hook also detects pickers; we mirror its
        // exclusivity here so a single pane carrying both texts (rare
        // bootstrap race) doesn't double-emit.
        const sessionPicker = /Resume session\b/i.test(paneText) && /Space to preview/i.test(paneText);
        const modePicker = /Resume from summary|Resume full session as-is|Don't ask me again/.test(paneText);
        return !sessionPicker && !modePicker;
    }
}

/** Footer-scoped detection of the y/N `Compact this conversation?`
 *  confirmation screen (used to be `isCompactConfirmPrompt` helper —
 *  kept as a wrapper for back-compat callers). */
export class CompactConfirmWatcher extends BoolWatcher {
    readonly name = "compactConfirm";
    private footerLines: number;
    constructor(footerLines = 12) {
        super();
        this.footerLines = footerLines;
    }
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const footer = paneText
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0)
            .slice(-this.footerLines)
            .join("\n");
        return /Compact this conversation\??/i.test(footer);
    }
}
