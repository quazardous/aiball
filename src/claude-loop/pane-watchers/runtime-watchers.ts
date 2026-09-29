/**
 * #845 Phase B — Watchers active in the runtime zone (always-on after
 * the loop starts). Three of them are simple bool classifiers ; the
 * fourth (error) has a richer state shape and lives in its own file.
 */

import { BoolWatcher } from "./bool-watcher.js";
import { paneFooterShowsBusy, paneShowsActivity, paneShowsInterrupted } from "../state.js";
import { footerOf } from "../error-backoff.js";
import { belowPromptBox } from "../pane-decor.js";
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

/** #1580 — Claude Code's activity line (spinner + elapsed + token counter) is
 *  visible. The busy signal that is actually CONTINUOUS while claude works,
 *  unlike the `esc to interrupt` hint this complements: measured 30/30 against
 *  5/30 on the same live trace. */
export class ActivityWatcher extends BoolWatcher {
    readonly name = "activity";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return paneShowsActivity(paneText);
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

/** #3074 — Claude Code installed an update of itself and says so in its
 *  footer: `✓ Update installed · Restart to update`. The loop publishes it in
 *  the bar (`alerts.restart_needed`) for a host to offer the restart; it never
 *  restarts on its own. #3164 — read below the input box only, where Claude
 *  renders it (its prompt footer's notices): the last lines of the pane also
 *  hold Claude's output while it writes, and a reply quoting the words latched
 *  the flag. */
export class UpdateInstalledWatcher extends BoolWatcher {
    readonly name = "update_installed";
    private static readonly BANNER = /Update installed\s*·\s*Restart to update/;
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return UpdateInstalledWatcher.BANNER.test(belowPromptBox(paneText));
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

/** #3268 — when a usage limit lifts, as Claude Code says it: the words, and the moment when they can be read. */
export interface LimitResets { text: string; at: string | null }

/**
 * #3268 — the `resets …` part of a limit banner: kept as said, and read as a
 * moment when it is a delay (`resets in 3h 20m`, `resets in 45m`, `in 2d`).
 * A clock time or a date (`resets 3pm (Europe/Paris)`) is kept as text only:
 * its reading depends on a timezone the pane does not always give.
 */
export function limitResetsOf(banner: string, nowMs: number): LimitResets | null {
    const m = /resets\s+([^·\n]+)/i.exec(banner);
    if (!m) return null;
    const text = m[1].trim();
    const d = /^in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i.exec(text);
    if (!d || !(d[1] || d[2] || d[3])) return { text, at: null };
    const ms = ((Number(d[1] ?? 0) * 24 + Number(d[2] ?? 0)) * 60 + Number(d[3] ?? 0)) * 60_000;
    return { text, at: new Date(nowMs + ms).toISOString() };
}

/** #3268 — Claude Code says a usage limit is reached: `You've hit your <name>
 *  limit` (weekly, session, 5-hour, Opus, the monthly spend limit), built at
 *  run time with an optional `· resets …`. Waking Claude is pointless until the
 *  reset. Not the fast mode's limit (Claude falls back to its normal model on
 *  its own), not the `You've used NN% of your weekly limit` warning. Footer
 *  only, prompt lines dropped — as NotLoggedInWatcher: a thread quoting the
 *  words must not trip it. `banner()` is the line that matched, for its reset. */
export class LimitReachedWatcher extends BoolWatcher {
    readonly name = "limit_reached";
    private static readonly BANNER = /You've hit your (?!fast limit)[A-Za-z0-9' -]{0,40}?limit\b[^\n]*/;
    private last: string | null = null;
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        const m = LimitReachedWatcher.BANNER.exec(footerOf(paneText, 8));
        this.last = m ? m[0] : null;
        return m !== null;
    }
    banner(): string | null {
        return this.last;
    }
}

/** #3291 — Claude is in Remote Control: Claude Code ends its status line, below
 *  the input box, with `/rc` (a link to the session on claude.ai), whatever
 *  turned it on — the flag at start or a `/rc` typed in the session. Below the
 *  box only: a `/rc` typed in the prompt, or quoted in a thread, is not it. */
export class RemoteControlWatcher extends BoolWatcher {
    readonly name = "remote_control";
    protected classify(paneText: string, _ctx: PaneScanCtx): boolean {
        return belowPromptBox(paneText).split("\n").some((l) => /(^|\s)\/rc$/.test(l.trim()));
    }
}
