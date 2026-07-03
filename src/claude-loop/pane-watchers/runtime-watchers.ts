/**
 * #845 Phase B — Watchers active in the runtime zone (always-on after
 * the loop starts). Three of them are simple bool classifiers ; the
 * fourth (error) has a richer state shape and lives in its own file.
 */

import { BoolWatcher } from "./bool-watcher.js";
import { paneFooterShowsBusy, paneShowsInterrupted } from "../state.js";
import { footerOf } from "../error-backoff.js";
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

/** #1072 — Claude Code is NOT logged in : the pane shows a login banner.
 *  Drives the ORANGE bar + wake-block. Only the `begin` edge is wired
 *  (kernel.ts) ; the flag is cleared on busy-begin / the first Stop hook, NOT
 *  by this watcher's `end` — the banner scrolling off-screen does not mean
 *  claude got logged in.
 *
 *  Hardened against the self-trip class (quick-win after the "bar stuck
 *  orange" report) : the original whole-pane loose regex (`Not logged in|
 *  Please run \/login`) latched on conversation text and the injected
 *  wake-CTA merely MENTIONING those words (ticket threads about this very
 *  bug…). Now: FOOTER-scoped with prompt-input lines dropped (`footerOf`,
 *  same as error-backoff #948/#919) + anchored on the full banner shapes as
 *  assembled by the Claude Code bundle (v2.1.199) :
 *    `Not logged in · Please run /login` / `Not logged in · Run /login`
 *    `Not logged in. Run claude auth login to authenticate.`
 *    `(Your) session has expired. Please run /login to sign in again.` */
export class NotLoggedInWatcher extends BoolWatcher {
    readonly name = "not_logged_in";
    private static readonly BANNERS = [
        /Not logged in\s*·\s*(?:Please run|Run) \/login/,
        /Not logged in\. Run claude auth login/,
        /session (?:has )?expired\. Please run \/login/i,
    ];
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const footer = footerOf(paneText, 8);
        return NotLoggedInWatcher.BANNERS.some((re) => re.test(footer));
    }
}

/** #1116 Slice 1 — Claude Code can't reach the API : the pane shows a retry
 *  banner like "Unable to connect to API (ConnectionRefused) · Retrying in 0s ·
 *  attempt 6/10". Claude auto-retries on its own, so waking it is pointless.
 *  This watcher drives the ORANGE bar (Slice 1) ; a wake-hold comes in Slice 2.
 *
 *  Anchored to avoid the #1119 self-trip class from the start : scan only the
 *  FOOTER with prompt-input lines dropped (`footerOf`, same as error-backoff),
 *  and require BOTH the "attempt N/M" retry counter AND a connection/retry
 *  keyword — so conversation text or an injected wake-CTA merely mentioning
 *  "connect"/"retry" can't latch the flag. The counter is the least-falsifiable
 *  fingerprint of the retry pane. Cleared on busy-begin / Stop (a running turn
 *  proves the API is reachable), never by the watcher `end` (a banner scrolling
 *  off-screen ≠ connectivity restored).
 *
 *  Regex confirmed against the shipped Claude Code bundle (v2.1.199), which
 *  assembles the banner as:
 *    `Unable to connect to API (${code}) · Retrying in ${n}${unit} · attempt ${a}/${max}`
 *  (the `·` is U+00B7). So the anchors below are ground-truth, not guessed. */
export class ApiUnreachableWatcher extends BoolWatcher {
    readonly name = "api_unreachable";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const footer = footerOf(paneText, 8);
        if (!/\battempt \d+\/\d+/i.test(footer)) return false;
        return /Unable to connect|ConnectionRefused|Retrying in\b|connect to API/i.test(footer);
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
