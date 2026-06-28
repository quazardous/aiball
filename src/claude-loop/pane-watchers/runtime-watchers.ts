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

/** #1072 — Claude Code is NOT logged in : the pane shows "Not logged in ·
 *  Please run /login". Drives the ORANGE bar + wake-block. Only the `begin`
 *  edge is wired (kernel.ts) ; the flag is cleared by the first Stop hook, NOT
 *  by this watcher's `end` — the banner scrolling off-screen does not mean
 *  claude got logged in. */
export class NotLoggedInWatcher extends BoolWatcher {
    readonly name = "not_logged_in";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return /Not logged in|Please run \/login/.test(paneText);
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

/** #898 david `<chat>` : "il y a une phrase qui permet de savoir si on
 *  est au prompt idle 'ctrl+t to show task'". Signal POSITIF d'idle
 *  prompt — quand la regex est visible MAIS PAS `esc to interrupt`,
 *  on est définitivement au prompt awaiting input. Si les 2 sont
 *  visibles ensemble, c'est busy (claude affiche le task hint pendant
 *  qu'il bosse).
 *
 *  Donne un signal déterministe pour clear le latch paneBusy stale
 *  (= cas où BusyWatcher loupe le change(false) parce que la regex
 *  reste sticky dans la fenêtre du footer). Consumer in timer.ts :
 *  `idlePromptW.on("begin", () => setPaneBusy(sd, false))`.
 *
 *  NB (#992) : la détection prompt-vide structurelle existe maintenant
 *  (`promptInputEmpty`) et sert d'INDICATEUR (glyphe `❯` coloré, #993),
 *  mais on NE l'a PAS câblée comme règle de clear ici — david explore,
 *  la règle viendra peut-être plus tard. Cette classe reste sur le
 *  hint `ctrl+t to show task`. */
export class IdlePromptWatcher extends BoolWatcher {
    readonly name = "idle_prompt";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const hasIdleHint = /ctrl\+t to show task/i.test(paneText);
        if (!hasIdleHint) return false;
        // Couplé : si "esc to interrupt" est aussi visible, on est busy
        // (claude affiche les 2 simultanément pendant un turn). Le signal
        // d'idle ne tire que quand le task hint apparaît SEUL.
        const isBusy = paneFooterShowsBusy(paneText);
        return !isBusy;
    }
}
