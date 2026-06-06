/**
 * #845 Phase B — Watchers active in the runtime zone (always-on after
 * the loop starts). Three of them are simple bool classifiers ; the
 * fourth (error) has a richer state shape and lives in its own file.
 */

import { BoolWatcher } from "./bool-watcher.js";
import { paneFooterShowsBusy, paneShowsInterrupted } from "../state.js";
import type { PaneScanCtx } from "./types.js";

/** Claude prompt visible (= `Claude Code v`, `❯ `, `> ` at line start).
 *  Combined with the boot-zone watchers (picker / resuming / compacting
 *  / compactConfirm) the SM derives `paneReady = promptVisible &&
 *  !pickerOrTransient`. This watcher only answers the first half. */
export class PromptWatcher extends BoolWatcher {
    readonly name = "prompt";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return /Claude Code v|❯ |^> /m.test(paneText);
    }
}

/** Claude footer says `esc to interrupt` → claude is mid-turn. The
 *  authoritative claude-busy signal (#B.173). */
export class BusyWatcher extends BoolWatcher {
    readonly name = "busy";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return paneFooterShowsBusy(paneText);
    }
}

/** "Interrupted by user" marker visible near the prompt — decoration
 *  only, not a wake gate (#345). */
export class InterruptedWatcher extends BoolWatcher {
    readonly name = "interrupted";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return paneShowsInterrupted(paneText);
    }
}
