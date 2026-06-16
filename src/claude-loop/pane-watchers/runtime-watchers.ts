/**
 * #845 Phase B — Watchers active in the runtime zone (always-on after
 * the loop starts). Three of them are simple bool classifiers ; the
 * fourth (error) has a richer state shape and lives in its own file.
 */

import { BoolWatcher } from "./bool-watcher.js";
import { paneFooterShowsBusy, paneShowsInterrupted } from "../state.js";
import { promptInputEmpty } from "./prompt-zone-watcher.js";
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

/** Positive idle-prompt signal used to clear the `paneBusy` latch when the
 *  Stop hook never fires — e.g. an ESC-interrupt aborts the turn, so no
 *  `idle:turn_ended` arrives. Consumer in timer.ts :
 *  `idlePromptW.on("begin", () => setPaneBusy(sd, false))`.
 *
 *  #992 david `<chat>` : "modifie le watcher du prompt pour savoir si le
 *  prompt est vide ou pas". STRUCTURAL detection now — input BOX visible AND
 *  empty (claude back at a fresh prompt) — replacing the old footer-hint regex
 *  `ctrl+t to show task`, which the agents UI swaps for `← for agents` (→ busy
 *  stuck ~5min until the SanityController net, the bug that motivated this).
 *
 *  `!paneFooterShowsBusy` keeps it from firing mid-turn : a busy frame ALSO
 *  shows an empty input box, but its footer still carries `esc to interrupt`.
 *  Typing mid-turn fills the box → `promptInputEmpty` is false → stays latched
 *  (#890). The lone-typed-space edge reads as empty (benign : re-latches on the
 *  next `esc to interrupt` frame). */
export class IdlePromptWatcher extends BoolWatcher {
    readonly name = "idle_prompt";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        if (!promptInputEmpty(paneText)) return false;
        return !paneFooterShowsBusy(paneText);
    }
}
