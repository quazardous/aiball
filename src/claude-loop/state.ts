/**
 * claude-loop state management (#B.63 TS port).
 *
 * Each loop has a state dir at `~/.claude-loop/<NAME>/` with:
 * - `plate.json`  — config the timer + stop hook read at runtime
 * - `pings.yaml`  — copy of the wake-up phrases pool (random pick)
 * - `idle-since`  — touched by the Stop hook when claude ends a turn
 * - `wake-requested` — touched by `claude-loop wake` to force next tick
 * - `timer.pid`   — pid of the detached timer process
 * - `timer.log`   — stdout/stderr of the timer
 */
import { spawnSync } from "node:child_process";
import { connect as netConnect, createServer as netCreateServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig, type AiballConfig } from "../autopoll/config.js";
import { AiballClient } from "../client.js";
import type { Intent } from "../domain.js";
import type { DrainedState } from "./drained-strategy.js";
import { CL_ENV } from "./env-vars.js";
import { canFlipBgFromBoot, computeLoopView } from "./loop-state.js";
import { parseGates, runGates } from "./gates.js";
import { loadPromptsFromYaml, mergePrompts, renderSlot } from "../prompt-templates.js";

export const STATE_ROOT = process.env.CLAUDE_LOOP_STATE_ROOT
    ?? join(homedir(), ".claude-loop");

export const MUX_CMD = process.env.MUX_CMD ?? "tmux";

export function stateDirFor(name: string): string {
    return join(STATE_ROOT, name);
}

/**
 * Tmux session name for a loop. Identity-pass-through : the loop name
 * itself carries the `cl-<project>-<hash>` prefix (#594), so we don't
 * re-wrap it here. Older loops created before #594 still have a bare
 * name like `cl-aiball` — `cl-${name}` would have produced the visible
 * double-`cl-` bug in `tmux ls`. Identity also makes the 3 names
 * (loop / state-dir / tmux session) align : same string everywhere.
 */
export function tmuxName(name: string): string {
    return name;
}

/**
 * #414 — canonicalise un cwd pour servir d'IDENTITÉ de loop (clé de lock +
 * guard anti-doublon + résolution par cwd). Deux alias du même dossier (un
 * chemin symlinké vs sa cible, ou `..`) doivent retomber sur UNE seule clé :
 * sinon `claude-loop start` depuis un alias rate le loop live enregistré sous
 * l'autre et spawn un doublon (cas david : `/home/david/dev` symlink vers
 * `/home/david/Private/dev`). `realpathSync` écrase les symlinks ; fallback sur
 * le chemin brut si la résolution échoue (path disparu) pour dégrader vers
 * l'ancien compare-par-chaîne au lieu de throw.
 */
export function canonicalCwd(p: string): string {
    try { return realpathSync(p); } catch { return p; }
}

export function ensureDir(p: string): void {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export interface Plate {
    /** Loop name (matches the state dir basename and tmux session suffix). */
    name: string;
    /** Created-at ISO timestamp. */
    created_at: string;
    /** Tick interval in seconds — the timer pings claude this often when idle. */
    interval: number;
    /**
     * Shell snippet the timer runs each tick to decide whether to
     * wake claude. Exit 0 = "there's work, ping"; non-zero = "nothing
     * to do, stay idle". Default is the aiball ping check
     * (`aiball pings-count -q`); pass `--check-cmd true` to ping
     * unconditionally on every tick. #B.63 v2.1.
     */
    check_cmd: string;
    /**
     * Absolute path to the YAML file with `ping_messages: [...]`.
     * The timer picks one at random per wake-up.
     */
    pings_path: string;
    /**
     * Working directory the tmux session was spawned in. Recorded so
     * `list`/`tail`/etc. can show it.
     */
    cwd: string;
    /**
     * The verbatim args the user passed AFTER `--` — handed back to
     * `claude` on spawn. Kept around so `respawn` (when we add it)
     * can reproduce the original invocation.
     */
    claude_args: string[];
    /**
     * git SHA of the claude-loop install root at the moment `cmdStart`
     * ran (#B.225 ghost detection). Used by `cmdList` / `cmdCheck` to
     * flag a running daemon whose timer was loaded from a source that
     * has since moved — the symptom that bit david on #225 (timer
     * stuck pre-`e1acaa3` paste-buffer fix). Optional: null when the
     * install root isn't a git checkout (binary install) or `git` is
     * missing.
     */
    started_at_sha?: string | null;
    /**
     * #390: remote-daemon connection. Present when the loop was started
     * against a REMOTE aiball (machine A) over HTTP+token instead of the
     * local Unix socket — `claude-loop start --aiball-url …`. Persisted so
     * `restart` replays the same connection. The loop process + tmux pane +
     * state files stay LOCAL (machine B); only the aiball data-plane
     * (tickets/comments/pings/uploads) travels over HTTP. Absent/null = the
     * default local-socket mode.
     */
    remote?: {
        url: string;
        token?: string;
        consumer?: string;
        project?: string;
    } | null;
}

/**
 * Resolve the current git SHA of the claude-loop install root, or
 * null when we can't (not a checkout, git missing, anything). Cheap
 * — spawned once at boot and once per `list`/`check` invocation.
 */
export function installRootSha(): string | null {
    try {
        const r = spawnSync("git", ["-C", installRoot(), "rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        if (r.status !== 0) return null;
        const sha = (r.stdout ?? "").trim();
        return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

/**
 * True iff the plate carries a `started_at_sha` AND the current install
 * root SHA differs from it — i.e. the loop's daemon timer was loaded
 * from a source that has since been updated, so the running code may
 * lag the repo. Null in either spot returns false (we can't claim
 * staleness without evidence both ways).
 */
export function isLoopStale(plate: Plate): boolean {
    const at = plate.started_at_sha ?? null;
    if (!at) return false;
    const now = installRootSha();
    if (!now) return false;
    return at !== now;
}

export function platePath(sd: string): string { return join(sd, "plate.json"); }
export function envPath(sd: string): string { return join(sd, "env"); }
/** #622 — loop session start timestamp (ms-since-epoch), written ONCE by
 *  `cli.ts` at launch. Both the long-lived timer and the short-lived hooks
 *  derive the boot-grace window from this single source — without it the
 *  hooks were reading `Date.now()` at module-load (= hook start), so they
 *  thought the boot window was always fresh. */
export function loopStartTsPath(sd: string): string { return join(sd, "loop-start-ts"); }
/** #647 Slice 2 david `sr9kqw` : claude --resume montre deux écrans
 *  successifs ; ils sont des markers DISTINCTS pour débugger un boot
 *  bloqué (savoir LEQUEL est à l'écran). Les writers vivent dans
 *  session-start-hook.ts (probes regex).
 *
 *  - `resume-session-picker-active` : 1er écran "Resume session" + "Space
 *    to preview" — choix de la session à reprendre.
 *  - `resume-mode-picker-active`    : 2e écran "Resume from summary" /
 *    "Resume full session as-is" / "Don't ask me again" — choix du mode
 *    de reprise.
 *
 *  Le legacy `resume-picker-active` (single file) n'existe plus, mais
 *  `readLoopStateInput.resumePickerActive` reste un OR des deux pour
 *  les consommateurs de l'API LoopStateInput. */
export function resumeSessionPickerActivePath(sd: string): string { return join(sd, "resume-session-picker-active"); }
export function resumeModePickerActivePath(sd: string): string { return join(sd, "resume-mode-picker-active"); }
/** #624 david `8pwvm3` : written ONCE when the session-start-hook completes
 *  (claude is past whatever pickers / loading were needed). The LoopState
 *  service ends the boot phase the moment this marker appears — the
 *  time-based cap (`bootGraceMs`) becomes a fail-safe for hooks that
 *  crash or never run. */
export function bootCompletePath(sd: string): string { return join(sd, "boot-complete"); }

/** #647 Slice 2 david `sr9kqw` : setters explicites pour chaque picker
 *  resume distinct (vs l'ancien `setResumePicker` qui ne disait pas
 *  lequel). session-start-hook appelle :
 *    - `setResumeSessionPicker(sd, true)`  au match du 1er écran
 *    - `setResumeModePicker(sd, true)`     au match du 2e écran
 *    - `clearResumePickers(sd)`            après dismiss des deux
 *
 *  bootComplete reste séparé (sealing via bus.on("bootEnded") + settleBoot).
 */
function _writePickerMarker(sd: string, p: string, active: boolean): void {
    if (active) {
        try { writeFileSync(p, new Date().toISOString() + "\n"); } catch { /* best-effort */ }
        return;
    }
    try { if (existsSync(p)) unlinkSync(p); } catch { /* race */ }
}

export function setResumeSessionPicker(sd: string, active: boolean): void {
    _writePickerMarker(sd, resumeSessionPickerActivePath(sd), active);
}

export function setResumeModePicker(sd: string, active: boolean): void {
    _writePickerMarker(sd, resumeModePickerActivePath(sd), active);
}

/** Clear both resume picker markers. Called when the hook is past the
 *  resume flow entirely (line 219 of session-start-hook). */
export function clearResumePickers(sd: string): void {
    setResumeSessionPicker(sd, false);
    setResumeModePicker(sd, false);
}

/** Back-compat alias kept for callers outside session-start-hook (notably
 *  the timer's safety-net dismiss). DEPRECATED in #647 ; new code should
 *  use the kind-specific setters above. */
export function setResumePicker(sd: string, active: boolean): void {
    if (active) setResumeSessionPicker(sd, true);
    else clearResumePickers(sd);
}

// #629 david `xyss9z` — debug log for tracing every `@cl_human` paint
// across cli.ts seed, setTmuxStatus, proxy paint_human, _apply_pushed_view,
// and the timer's bus transition listener. Off by default ; opt in with
// `CL_BAR_PAINT_LOG=1`. Each writer emits one line with monotonic
// `T+Xms` since process start of the writer + the value being painted.
// Appends to `<state_dir>/bar-paint.log`. Reading the file from the
// outside (`tail -f`) lets the user (david) trace the flicker order.
export function barPaintLogPath(sd: string): string { return join(sd, "bar-paint.log"); }

const BAR_PAINT_LOG_ENABLED = process.env.CL_BAR_PAINT_LOG === "1";
const BAR_PAINT_LOG_T0 = Date.now();

export function logBarPaint(sd: string | undefined, writer: string, value: string): void {
    if (!BAR_PAINT_LOG_ENABLED || !sd) return;
    try {
        const tMs = Date.now() - BAR_PAINT_LOG_T0;
        appendFileSync(barPaintLogPath(sd), `[bar-paint] T+${tMs}ms ${writer} @cl_human=${value}\n`);
    } catch { /* best-effort */ }
}

// #624 david `62ys4g` : "le pane est pas contrôlable donc reste externe go".
// Pane-* signals are external (claude TUI drives them) — same setter pattern
// as `setResumePicker`. Each writes/removes a marker file ; the state machine
// reads them via `readLoopStateInput`. The TIMER's pane probe (mainSse) is
// the canonical caller, but stop-hook also writes some of them on its own
// snapshot.
export function paneBusyPath(sd: string): string { return join(sd, "pane-busy"); }
export function paneReadyPath(sd: string): string { return join(sd, "pane-ready"); }
export function paneCompactingPath(sd: string): string { return join(sd, "pane-compacting"); }
/** #647 david `4h75nk` : marker pour l'écran "Resuming conversation…"
 *  qui apparaît après l'auto-pick du picker session, avant que claude
 *  affiche le prompt. Transitoire (1-3s sur sessions courtes, plus sur
 *  grosses) mais visible à l'écran → mérite sa propre catégorie. Membre
 *  du SCREEN_TAKEOVER_GROUP (exclusif des pickers et Compacting). */
export function paneResumingPath(sd: string): string { return join(sd, "pane-resuming"); }
export function paneInterruptedPath(sd: string): string { return join(sd, "pane-interrupted"); }

function writeOrUnlink(p: string, set: boolean): void {
    if (set) {
        try { writeFileSync(p, new Date().toISOString() + "\n"); } catch { /* best-effort */ }
    } else {
        try { if (existsSync(p)) unlinkSync(p); } catch { /* race */ }
    }
}

/** #624 david `62ys4g` : claude pane shows `esc to interrupt` in its
 *  footer. Setter called by the pane probe (timer / stop-hook). */
export function setPaneBusy(sd: string, busy: boolean): void {
    writeOrUnlink(paneBusyPath(sd), busy);
}
/** #624 david `62ys4g` : claude pane shows the prompt signature
 *  (`Claude Code v`, `❯ `, …). Setter called by the pane probe. */
export function setPaneReady(sd: string, ready: boolean): void {
    writeOrUnlink(paneReadyPath(sd), ready);
}
/** #624 david `62ys4g` : claude is mid-compact (`/compact` or auto-compact).
 *  Wake gate skips while this is on. */
export function setCompacting(sd: string, compacting: boolean): void {
    writeOrUnlink(paneCompactingPath(sd), compacting);
}
/** #647 david `4h75nk` : claude pane shows "Resuming conversation…" —
 *  post-picker, pre-prompt. */
export function setResuming(sd: string, resuming: boolean): void {
    writeOrUnlink(paneResumingPath(sd), resuming);
}
/** #624 david `62ys4g` : claude pane shows `interrupted by user`. Decorates
 *  the bar tag `[idle:interrupted]` ; not a wake gate. */
export function setInterrupted(sd: string, interrupted: boolean): void {
    writeOrUnlink(paneInterruptedPath(sd), interrupted);
}
export function pingsPath(sd: string): string { return join(sd, "pings.yaml"); }
export function idleMarkerPath(sd: string): string { return join(sd, "idle-since"); }
export function wakeRequestedPath(sd: string): string { return join(sd, "wake-requested"); }
export function userTookOverPath(sd: string): string { return join(sd, "user-took-over"); }
/** #351: AFK marker — the human flagged themselves absent via the afk_key
 *  combo. The PTY proxy writes it on the combo and deletes it on any other
 *  activity (and on boot), so its mere existence means "currently away". */
export function afkPath(sd: string): string { return join(sd, "afk"); }
// #264: near-live "a human is typing in the tmux pane" marker. Touched
// by the timer's detection poll when the prompt area changes while
// at-prompt; read by setTmuxStatus to paint the bicolor human chip and
// usable as a finer human-present signal than the submit-time user-took-over.
export function humanTypingPath(sd: string): string { return join(sd, "human-typing"); }
// #269: UDS control socket the PTY proxy listens on for wake injection.
// Present ⇒ the pane runs under the proxy (injection goes here instead of
// tmux send-keys; the proxy owns the human-typing marker).
export function injectSockPath(sd: string): string { return join(sd, "inject.sock"); }
/** #627 — UDS the proxy listens on for view-push messages from the timer.
 *  Separate from `inject.sock` (raw wake bytes) so the protocols stay
 *  isolated. Newline-delimited JSON, persistent connection from the
 *  timer side (auto-reconnect on drop). */
export function viewPushSockPath(sd: string): string { return join(sd, "view-push.sock"); }
// #281 (strategy B): Windows has no AF_UNIX file sockets, so the Rust
// ConPTY proxy listens on a NAMED PIPE instead. Both sides derive the
// name from the loop name (= basename of the state dir, == CL_NAME).
// Can't be stat'd like a file, so callers gate on proxyIsAlive() rather
// than existsSync(). Used by injectWakePhrase on win32 only.
export function injectPipeName(sd: string): string {
    return `\\\\.\\pipe\\cl-inject-${basename(sd)}`;
}
// #269 (tcn5ej): presence marker dropped by the PTY proxy right after a
// successful pty.fork, removed at cleanup. Existence ⇒ the pane really runs
// under the proxy — GROUND TRUTH, vs the TS launch decision which can lie (the
// proxy self-falls-back to exec-claude if PTY init fails). Read by
// setTmuxStatus to paint the discreet proxy glyph.
export function proxyAlivePath(sd: string): string { return join(sd, "proxy-alive"); }
// #633 david `ecmrvn` (Slice A) — back-channel UDS the proxy connects to
// at startup, emitting raw events (typing, AFK key, lone-esc) so the
// timer's state machine decides what to do (arm AFK, toggle, …). Inverse
// direction of view-push.sock (timer→proxy). Newline-delimited JSON.
export function proxyEventsSockPath(sd: string): string { return join(sd, "proxy-events.sock"); }
export function timerPidPath(sd: string): string { return join(sd, "timer.pid"); }
export function timerLogPath(sd: string): string { return join(sd, "timer.log"); }
/**
 * Touched by the timer / stop-hook RIGHT BEFORE they `send-keys` an
 * auto-wake into the claude pane (#B.180 david: the wake itself
 * triggered UserPromptSubmit → user-took-over → tryWake locked for
 * 5 min). The UserPromptSubmit hook checks this marker on fire: if
 * present + mtime < ~2s, the prompt came from claude-loop itself,
 * skip the user-took-over touch. Marker then deleted by the hook.
 */
export function wakeInFlightPath(sd: string): string { return join(sd, "wake-in-flight"); }
/** Wake-in-flight markers older than this many ms are stale and
 *  ignored — covers race where the user types BEFORE claude-loop's
 *  wake reaches the hook (unlikely but possible). #B.180:
 *  yaml-configurable via `.aiball.yaml claude_loop.wake_in_flight_ttl_ms`,
 *  exposed to child processes via CL_WAKE_IN_FLIGHT_TTL_MS env. */
export const WAKE_IN_FLIGHT_TTL_MS = Math.max(0, Number(process.env[CL_ENV.WAKE_IN_FLIGHT_TTL_MS] ?? 2000));

/**
 * Touched by ANY wake path (Stop hook chain-fire AND timer's
 * tryWake) right before the send-keys. Read by the Stop hook to
 * coalesce a burst of chain-fires (#B.198 fix A): when N events were
 * unread, the hook used to fire N back-to-back wakes — each turn was
 * a 3-5s loop responding to a pop phrase, all queued tickets drained
 * across N turns instead of one. The coalesce now suppresses
 * subsequent chain-fires whose previous wake was within the window,
 * leaving the timer/SSE path to wake again on the next genuine event
 * arrival or heartbeat tick.
 */
export function lastWakeAtPath(sd: string): string { return join(sd, "last-wake-at"); }
/** Wake-coalesce window — Stop hook skips its chain-fire if the
 *  prior wake was sent within this many ms ago. Default 3s covers
 *  the typical short pop-phrase turn (1-5s) that produced the
 *  "wake-on-busy" perception in #B.198. */
// #623 david `7fh9rk` : default bumped 3s → 30s because the counter
// model collapses ANY wake within the window, not just same-phrase.
// 30s is roughly one heartbeat tick, so a burst of triggers between
// two heartbeats becomes a single fire. Env-tunable via
// CL_WAKE_COALESCE_WINDOW_MS.
export const WAKE_COALESCE_WINDOW_MS = Math.max(0, Number(process.env[CL_ENV.WAKE_COALESCE_WINDOW_MS] ?? 30000));

/**
 * Last successful wake's hint, written as JSON `{ticket_id,
 * comment_hashid}` right after `send-keys`. Read by the SSE consumer
 * to coalesce IDENTICAL events (#B.198 david: "on cumule pas les
 * event identique on les merge"). When N SSE pings about the same
 * (ticket, comment) arrive in a burst, only the first triggers a
 * wake; subsequent dups within `WAKE_COALESCE_WINDOW_MS` are dropped
 * at the hook layer — no DB / model change ("on touche pas au model,
 * on merge au moment des event dans / hook"). mtime is the "at" so
 * the JSON body stays free of timestamps.
 */
export function lastWakeHintPath(sd: string): string { return join(sd, "last-wake-hint"); }

/**
 * #409 — single-chokepoint wake-injection dedup. The wake sites (timer
 * SSE-wake, Stop-hook post-turn wake, session-start) run as SEPARATE
 * processes and every one funnels through `injectWakePhrase`. The
 * upstream coalesces (`lastWakeHint` at the SSE consumer, `lastWakeAt`
 * at the Stop hook) are per-decider — they don't see a sibling site
 * about to fire, so two sites could each inject the SAME rendered CTA
 * within a beat (david: « le wakeup a été envoyé 3 fois »). This marker
 * is the cross-process catch-all: the last phrase actually injected +
 * when. Format: ISO-timestamp + "\n" + phrase (the phrase may itself
 * contain newlines — everything after the first "\n" is the phrase).
 */
export function lastInjectedWakePath(sd: string): string { return join(sd, "last-injected-wake"); }

/**
 * #409 — pure dedup decision for the injection chokepoint. Given the
 * previous marker content (or null), the phrase about to be injected,
 * the current time, and the coalesce window: SKIP if the SAME phrase was
 * injected less than `windowMs` ago (a sibling site already fired it);
 * otherwise inject and return the marker string to persist. Keyed on
 * phrase-identity (not just "any wake") so distinct legitimate wakes are
 * never dropped. `windowMs <= 0` disables the dedup (always inject).
 */
export function dedupeWakeInjection(
    prevMarker: string | null,
    phrase: string,
    nowMs: number,
    windowMs: number,
): { skip: boolean; write: string | null } {
    // #623 david `7fh9rk` : counter model, not queue. A wake fires
    // ONCE per "opportunity" — any trigger that lands within `windowMs`
    // of a prior fire collapses to that single fire, regardless of
    // phrase content. The old #409 phrase-equality check was a bandaid
    // (random culture lead masked context-identical wakes). The phrase
    // is still persisted in the marker as a diagnostic of "what fired
    // last" — never compared.
    if (windowMs > 0 && prevMarker) {
        const nl = prevMarker.indexOf("\n");
        if (nl > 0) {
            const age = nowMs - Date.parse(prevMarker.slice(0, nl));
            if (age >= 0 && age < windowMs) {
                return { skip: true, write: null };
            }
        }
    }
    return { skip: false, write: new Date(nowMs).toISOString() + "\n" + phrase };
}

/**
 * #409 — fs side of the injection dedup: read the marker, decide via
 * `dedupeWakeInjection`, persist when injecting. Returns true to SKIP.
 * Fails open (inject) on any fs error — a missed dedup is harmless, a
 * dropped wake is not.
 */
function skipDuplicateWakeInjection(sd: string, phrase: string): boolean {
    let prev: string | null = null;
    try { prev = readFileSync(lastInjectedWakePath(sd), "utf8"); } catch { /* no marker yet */ }
    const { skip, write } = dedupeWakeInjection(prev, phrase, Date.now(), WAKE_COALESCE_WINDOW_MS);
    if (skip) return true;
    try { if (write !== null) writeFileSync(lastInjectedWakePath(sd), write); } catch { /* ignore — fail open */ }
    return false;
}

/**
 * Session-volatile watermark for the open-tickets wake gate (#B.232
 * david ch887f: "il faut un mécanisme pour les ack et qu'ils ne
 * reviennent plus pour cette session si c'est du bruit, mémoire
 * volatile au daemon par exemple"). Stores the open-ticket count that
 * was already mentioned in a wake CTA in this loop session. The gate
 * fires on open tickets only when the current count EXCEEDS this
 * watermark (i.e. a NEW ticket landed since the last time claude was
 * pinged about open work) — drained pings still wake unconditionally.
 *
 * Lifetime = the state dir. `claude-loop rm` wipes it; restart of the
 * same loop name keeps it (which matches david's intent: if you saw
 * the same N tickets last session, don't re-fire on the next).
 */
export function lastOpenWakeCountPath(sd: string): string {
    return join(sd, "last-open-wake-count");
}

/** Read the watermark; 0 when missing/unparseable (treat as "never woken"). */
export function readLastOpenWakeCount(sd: string): number {
    try {
        const v = Number(readFileSync(lastOpenWakeCountPath(sd), "utf8").trim());
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    } catch {
        return 0;
    }
}

/** Persist the watermark after a successful wake. Best-effort. */
export function recordOpenWakeCount(sd: string, count: number): void {
    try {
        writeFileSync(lastOpenWakeCountPath(sd), `${Math.max(0, Math.floor(count))}\n`);
    } catch { /* gate fails-open next tick, not fatal */ }
}

/**
 * #379: set-aware dedup watermark for the actionable wake leg. Replaces the
 * count watermark (`last-open-wake-count`) with the `landscape_hash` — the
 * count missed SWAPS (a ticket leaves my court while another enters → count
 * constant → no re-wake → the new actionable ticket never surfaced). The hash
 * changes on any set churn, so the same N idle tickets stay deduped but a
 * genuine change re-wakes. Falls back to the count path when the daemon doesn't
 * supply a hash (old version). Lifetime = the state dir (same as the count).
 */
export function lastOpenWakeHashPath(sd: string): string {
    return join(sd, "last-open-wake-hash");
}

/** Read the last landscape hash we woke on; "" when missing (→ first wake). */
export function readLastOpenWakeHash(sd: string): string {
    try {
        return readFileSync(lastOpenWakeHashPath(sd), "utf8").trim();
    } catch {
        return "";
    }
}

/** Persist the landscape hash after a successful wake. Best-effort. */
export function recordOpenWakeHash(sd: string, hash: string): void {
    try {
        writeFileSync(lastOpenWakeHashPath(sd), `${hash}\n`);
    } catch { /* gate fails-open next tick, not fatal */ }
}

/**
 * #379: persistent state of the drained-strategy (marker `drained-state`). The
 * timer is the SOLE writer (heartbeat-owned) — hooks fire on activity, not on
 * idle backlog, so they never touch it (no cross-process race). Persisted on
 * EVERY drained tick so `backoff`/`stale`/`once` can track when the landscape
 * appeared and whether they already fired. See drained-strategy.ts.
 */
export function drainedStatePath(sd: string): string { return join(sd, "drained-state"); }

/** Read the drained-strategy state, or null (missing / unparseable → fresh). */
export function readDrainedState(sd: string): DrainedState | null {
    try {
        const o = JSON.parse(readFileSync(drainedStatePath(sd), "utf8")) as DrainedState;
        if (o && typeof o.hash === "string") return o;
        return null;
    } catch {
        return null;
    }
}

/** Persist the drained-strategy state. Best-effort. */
export function writeDrainedState(sd: string, state: DrainedState): void {
    try {
        writeFileSync(drainedStatePath(sd), JSON.stringify(state) + "\n");
    } catch { /* next tick recomputes from scratch (re-arms), not fatal */ }
}

/** Persist the hint that just triggered a wake. Pass `undefined` to
 *  no-op (we only want hinted wakes in the dedup ledger; un-hinted
 *  pop-culture wakes coalesce via `lastWakeAtPath` already). */
export function recordWakeHint(sd: string, hint: WakeHint | undefined): void {
    if (!hint || hint.ticket_id === undefined) return;
    try {
        writeFileSync(lastWakeHintPath(sd), JSON.stringify({
            ticket_id: hint.ticket_id,
            comment_hashid: hint.comment_hashid ?? null,
        }) + "\n");
    } catch { /* coalesce will just fail open on next event */ }
}

/** True iff `hint` matches the last recorded wake hint AND the marker
 *  is fresher than `windowMs`. Use to drop duplicate SSE pings before
 *  invoking the wake path. Returns false on missing marker / parse
 *  error / no ticket id — fail-open so a corrupt ledger never silences
 *  a real ping. */
export function isDuplicateWakeHint(sd: string, hint: WakeHint | undefined, windowMs: number): boolean {
    if (!hint || hint.ticket_id === undefined) return false;
    const p = lastWakeHintPath(sd);
    if (!existsSync(p)) return false;
    try {
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > windowMs) return false;
        const prev = JSON.parse(readFileSync(p, "utf8")) as { ticket_id?: number; comment_hashid?: string | null };
        return prev.ticket_id === hint.ticket_id
            && (prev.comment_hashid ?? null) === (hint.comment_hashid ?? null);
    } catch { return false; }
}

/** #B.198 — defer (not gate) the next wake when the Stop-hook fire-time
 *  pane still shows `esc to interrupt`. The footer may be stale (#B.185)
 *  so a hard skip would lose wakes; the marker-based defer survives the
 *  hook process exiting. */
export const PANE_BUSY_DELAY_MS = Math.max(0, Number(process.env[CL_ENV.PANE_BUSY_DELAY_MS] ?? 5000));

/**
 * Wake-defer gate. File content is the ISO target time at which the
 * gate opens again. Written by the Stop hook when it sees pane.busy;
 * read by the timer's `tryWake` to short-circuit a wake during the
 * window. Persistent so:
 *   - the gate survives if the Stop hook process dies before the
 *     window elapses ("staker oublié c plus facile" — david's reason
 *     for moving away from the in-hook `await sleep`);
 *   - `cat busy-defer-until` shows the next-allowed wake time at a
 *     glance for debugging.
 *
 * No mtime arithmetic on purpose — the absolute target is the source
 * of truth, and a manual `touch` won't accidentally extend / shorten
 * the gate.
 */
export function busyDeferUntilPath(sd: string): string { return join(sd, "busy-defer-until"); }

/** Arm the defer gate so the next wake is blocked until `now + ms`.
 *  Writes the absolute target as ISO. Idempotent: pushes the existing
 *  gate forward if the new target is later, never shortens an existing
 *  defer (a fresh busy snapshot mid-defer extends the wait, doesn't
 *  cut it). */
export function armBusyDefer(sd: string, ms: number): string {
    if (ms <= 0) return "";
    const target = new Date(Date.now() + ms);
    const p = busyDeferUntilPath(sd);
    if (existsSync(p)) {
        try {
            const prev = new Date(readFileSync(p, "utf8").trim());
            if (!Number.isNaN(prev.getTime()) && prev.getTime() > target.getTime()) {
                return prev.toISOString();
            }
        } catch { /* fall through and overwrite */ }
    }
    const iso = target.toISOString();
    try { writeFileSync(p, iso + "\n"); } catch { /* fail open */ }
    return iso;
}

/** Read the defer marker. Returns `{ activeMs }` with the remaining
 *  defer window in ms, or `null` if the gate is open (no marker, parse
 *  failure, or target already past). Side effect: deletes the marker
 *  when the gate has opened, so subsequent calls return null cleanly. */
export function readBusyDefer(sd: string): { activeMs: number; until: Date } | null {
    const p = busyDeferUntilPath(sd);
    if (!existsSync(p)) return null;
    try {
        const until = new Date(readFileSync(p, "utf8").trim());
        const activeMs = until.getTime() - Date.now();
        if (!Number.isFinite(activeMs) || activeMs <= 0) {
            try { unlinkSync(p); } catch { /* race */ }
            return null;
        }
        return { activeMs, until };
    } catch {
        try { unlinkSync(p); } catch { /* race */ }
        return null;
    }
}

export function readPlate(sd: string): Plate {
    return JSON.parse(readFileSync(platePath(sd), "utf8")) as Plate;
}

export function writePlate(sd: string, p: Plate): void {
    writeFileSync(platePath(sd), JSON.stringify(p, null, 2) + "\n");
}

/** Resolve the install root by walking up from this module. */
export function installRoot(): string {
    // src/claude-loop/state.ts → up 2 = repo root.
    // Use fileURLToPath rather than `new URL(...).pathname` because on
    // Windows the latter returns "/C:/path/..." (URL-style absolute
    // path with a leading slash), which path.resolve then mis-parses
    // — `resolve("/C:/...", "..", "..")` produces "C:\C:\..." with
    // a duplicated drive letter. fileURLToPath does the right thing.
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
}

/** Path to the default ping phrases yaml shipped with the install. */
export function defaultPingsPath(): string {
    return join(installRoot(), "config", "defaults", "claude-loop-pings.yaml");
}

/**
 * Legacy sentinel (#B.63 v2.1) — was the previous default. Kept as a
 * back-compat marker so loops spawned before the SDK-default
 * refactor (#B.154) still resolve to the in-process AiballClient
 * path instead of trying to shell out to `aiball` (which would
 * fork+exec the CLI on every tick — david: "c'est tres moche").
 *
 * NEW DEFAULT: empty string → AiballClient.pingsCount() directly.
 * Any non-empty, non-sentinel string → shell out (custom check-cmd).
 */
export const DEFAULT_CHECK_CMD = "";
const LEGACY_AIBALL_CHECK_CMD = "aiball pings-count -q";

/**
 * The "is there work to drain?" gate used by every wake surface
 * (timer tick + SessionStart hook + Stop hook).
 *
 * Behavior:
 *   - Empty (default) OR the legacy `"aiball pings-count -q"`
 *     sentinel → call AiballClient.pingsCount() in-process (no
 *     fork). Caller passes its own cached client to keep the
 *     keep-alive socket warm across ticks.
 *   - `"true"` → always wake (legacy "pure timer" mode).
 *   - Anything else → shell out via `bash -c <cmd>`; exit 0 = work.
 *
 * Async because the in-process path returns a promise.
 *
 * #B.232 (david dd8rdd): the internal-SDK path also factors in
 * open-ticket count (actionable) alongside unread pings. Repro:
 * david drained pings cleanly with 4 open tickets still actionable;
 * the timer heartbeat then reported `no unread pings` and parked
 * claude in `idle` while there was still work. Now the gate returns
 * true if EITHER pings>0 OR open>0 — the wake CTA already mentions
 * both via `buildContextPhrase`, so the chained directive
 * ("drain via unread + engage one of N open via ticket_list") lands cleanly.
 *
 * #B.232 (david ch887f): when `sd` is provided, the open-tickets leg
 * is suppressed if `openCount <= watermark` (already-acked open
 * tickets don't re-fire on every heartbeat). Watermark drops with
 * openCount so a closed-then-reopened ticket re-triggers correctly.
 * Caller bumps the watermark via `recordOpenWakeCount(sd, openCount)`
 * after a successful wake (post send-keys, in the same site that
 * writes `last-wake-at`).
 *
 * Returns `{ has, pingsCount, openCount }` so the caller can persist
 * the watermark without a second round-trip; legacy shell-out branch
 * returns counts=0 since they aren't observable.
 */
export interface CheckHasWorkResult {
    has: boolean;
    pingsCount: number;
    /** Actionable count (tickets in MY court). Kept named `openCount` for
     *  back-compat (timer log + count-watermark fallback). */
    openCount: number;
    /** #379: total OPEN tickets incl. gated / awaiting-human — drives the
     *  timer's drained-reminder branch (distinct from the actionable count). */
    totalOpenCount: number;
    /** #379: combined landscape_hash over the in-scope project(s), or undefined
     *  when the daemon didn't supply it (older version → count-watermark path). */
    landscapeHash?: string;
    /** #379: max(last_actor_at) over open tickets in ms, or null — for `stale`. */
    lastActivityMs: number | null;
}
function emptyWork(over: Partial<CheckHasWorkResult> = {}): CheckHasWorkResult {
    return { has: false, pingsCount: 0, openCount: 0, totalOpenCount: 0, lastActivityMs: null, ...over };
}
export async function checkHasWork(
    checkCmd: string | null | undefined,
    client?: AiballClient,
    project?: string | null,
    sd?: string | null,
): Promise<CheckHasWorkResult> {
    const cmd = checkCmd ?? "";
    if (cmd === "true") return emptyWork({ has: true });
    if (cmd === "" || cmd === LEGACY_AIBALL_CHECK_CMD) {
        const c = client ?? new AiballClient();
        try {
            const [pingsR, projects] = await Promise.all([
                c.pingsCount() as Promise<{ unread?: number }>,
                // #379: ask for the landscape so the actionable dedup is
                // set-aware (hash) and the drained branch has its primitive.
                c.listProjectsDetailed({ landscape: true }).catch(() => []) as Promise<Array<{
                    name: string;
                    open_count?: number;
                    actionable_count?: number;
                    landscape_hash?: string;
                    landscape_last_activity?: string | null;
                }>>,
            ]);
            const filtered = Array.isArray(projects)
                ? projects.filter((p) => !project || p.name === project)
                : [];
            const pingsCount = pingsR.unread ?? 0;
            const actionableCount = filtered.reduce((acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0), 0);
            const totalOpenCount = filtered.reduce((acc, p) => acc + (p.open_count ?? 0), 0);
            const hashes = filtered.map((p) => p.landscape_hash).filter((h): h is string => typeof h === "string");
            // Combined signature across the in-scope projects (sorted → stable).
            const landscapeHash = hashes.length ? hashes.slice().sort().join("|") : undefined;
            let lastActivityMs: number | null = null;
            for (const p of filtered) {
                if (!p.landscape_last_activity) continue;
                const t = Date.parse(p.landscape_last_activity);
                if (!Number.isNaN(t) && (lastActivityMs === null || t > lastActivityMs)) lastActivityMs = t;
            }
            const base = { pingsCount, openCount: actionableCount, totalOpenCount, landscapeHash, lastActivityMs };
            if (pingsCount > 0) return { has: true, ...base };
            // #379 actionable leg — set-aware hash dedup (Q2): re-wake only when
            // the landscape moved since the last wake (catches swaps the count
            // watermark missed). Fall back to the count watermark when the
            // daemon supplied no hash (zero regression on old versions).
            if (sd && landscapeHash !== undefined) {
                const seen = readLastOpenWakeHash(sd);
                return { has: actionableCount > 0 && landscapeHash !== seen, ...base };
            }
            if (sd) {
                const watermark = readLastOpenWakeCount(sd);
                if (actionableCount < watermark) {
                    recordOpenWakeCount(sd, actionableCount);
                    return { has: false, ...base };
                }
                return { has: actionableCount > watermark, ...base };
            }
            return { has: actionableCount > 0, ...base };
        } catch {
            return emptyWork();
        }
    }
    const r = spawnSync("bash", ["-c", cmd], { stdio: "ignore" });
    return emptyWork({ has: r.status === 0 });
}

/**
 * True when the given check-cmd is the SDK-direct mode (empty or
 * legacy sentinel). Used by the timer to decide SSE vs polling
 * loop without re-comparing strings everywhere.
 */
export function isInternalCheckCmd(checkCmd: string | null | undefined): boolean {
    const cmd = checkCmd ?? "";
    return cmd === "" || cmd === LEGACY_AIBALL_CHECK_CMD;
}

/**
 * Default user-grace window in seconds (#B.145 v2.2, recalibrated
 * #B.185, then #619 david `e54hx2` bumped 60s → 600s). When the user
 * has typed a prompt within this window, the timer skips its wake so
 * the wrapper doesn't `send-keys` over a human-driven session AND the
 * `AskUserQuestion` dialog stays allowed. 600s = 10min matches the
 * pre-collapse `ask_grace_seconds` so a present-but-quiet human can
 * still pop a dialog ; F9 (afk_key) lets you release earlier. Tunable
 * via `CL_USER_GRACE_SEC`.
 */
export const DEFAULT_USER_GRACE_SEC = 600;

/**
 * Is the human actively driving the session? True iff the
 * `user-took-over` marker exists AND its mtime is within the grace
 * window. The marker is refreshed on every UserPromptSubmit hook
 * fire (#B.145), so any prompt the human submits keeps the loop
 * deferential for `graceSec` more seconds.
 */
export function userIsTakingOver(sd: string, graceSec: number): boolean {
    const p = userTookOverPath(sd);
    if (!existsSync(p)) return false;
    try {
        return (Date.now() - statSync(p).mtimeMs) < graceSec * 1000;
    } catch {
        return false;
    }
}

/** #351 / #619 collapse — kept as an alias of `DEFAULT_USER_GRACE_SEC`
 *  for back-compat. The historical 2-window distinction (short user-grace
 *  for wakes vs long ask-grace for AskUserQuestion) was retired in #619 :
 *  both gates now share the single user-grace window. A project that
 *  still sets `ask_grace_seconds` in `.aiball.yaml` is honored at the
 *  config layer (treated as user_grace_seconds) ; setting both with
 *  different values is OK — the gate uses `max(user, ask)` so neither
 *  knob silently shrinks the deferential window. */
export const DEFAULT_ASK_GRACE_SEC = DEFAULT_USER_GRACE_SEC;

/** #351 + #619 david `f97nu6` : true when the human has flagged AFK
 *  (3-state cycle via the AFK key). File format :
 *    absent       → OFF
 *    "inf"        → AFK ∞ (held)
 *    "<iso-ts>"   → AFK auto-release at that timestamp
 *  Returns true for any active mode (`inf` or `until > now`). */
export function afkActive(sd: string): boolean {
    const p = afkPath(sd);
    if (!existsSync(p)) return false;
    try {
        const content = readFileSync(p, "utf8").trim();
        if (!content || content === "inf") return true;
        const until = new Date(content).getTime();
        if (Number.isNaN(until)) return true; // unparseable → degrade to ∞
        return until > Date.now();
    } catch {
        return false;
    }
}

/** #624 david `e3a6nn` : arm a NOT AFK 10m hold from the TS side
 *  (settleBoot's `--wait` path). Writes an ISO expiry timestamp,
 *  mirror of the proxy's `set_afk_until`. No-op on fs error — the
 *  bar just stays at whatever the natural state computes to. */
export function armAfk10m(sd: string, seconds = 600): void {
    try {
        const expiry = new Date(Date.now() + seconds * 1000);
        writeFileSync(afkPath(sd), expiry.toISOString() + "\n");
    } catch { /* best-effort */ }
}

/** #633 Slice C — mirror of the proxy's `set_afk_infinite` : write the
 *  AFK file with content `inf` (NOT AFK ∞ hold, released only by F9). */
export function setAfkInfinite(sd: string): void {
    try { writeFileSync(afkPath(sd), "inf\n"); } catch { /* best-effort */ }
}

/** #633 Slice C — mirror of the proxy's `clear_afk` : remove the AFK
 *  marker file → bar returns to AFK (autonomous loop, no hold). */
export function clearAfk(sd: string): void {
    try { if (existsSync(afkPath(sd))) unlinkSync(afkPath(sd)); } catch { /* race */ }
}

/** #633 Slice C — clear the user-took-over marker (release the silent
 *  user-grace wake gate). Companion to `clearAfk` in the toggle path
 *  NOT AFK ∞ → AFK (both holds released atomically). */
export function clearUserGrace(sd: string): void {
    try { if (existsSync(userTookOverPath(sd))) unlinkSync(userTookOverPath(sd)); } catch { /* race */ }
}

/** #633 Slice D — touch the `human-typing` marker (writes mtime to now).
 *  The bus reads its mtime via `safeMtime` to compute `isTypingNow` →
 *  bar word "stop" during the 5s TTL. Mirror of the proxy's
 *  `touch_marker`. */
export function touchHumanTyping(sd: string): void {
    try { writeFileSync(humanTypingPath(sd), new Date().toISOString() + "\n"); } catch { /* best-effort */ }
}

/** #633 Slice D — touch the `user-took-over` marker (writes mtime to now).
 *  The bus reads its mtime to compute `isUserGraceFresh` → silently gates
 *  auto-wakes for the user-grace window. Mirror of the proxy's
 *  `touch_user_grace`. */
export function touchUserGrace(sd: string): void {
    try { writeFileSync(userTookOverPath(sd), new Date().toISOString() + "\n"); } catch { /* best-effort */ }
}

/** #633 Slice C — F9 toggle implemented on the TS side. Reads the
 *  current AFK mode and cycles to the next : off → wait_10m → wait_inf
 *  → off. The ∞ → off branch also clears user-grace (atomic release
 *  of both holds — matches the proxy's `toggle_afk`). */
export function toggleAfk(sd: string, seconds = 600): void {
    const cur = readAfkState(sd);
    if (cur.mode === "off") {
        armAfk10m(sd, seconds);
    } else if (cur.mode === "wait_10m") {
        setAfkInfinite(sd);
    } else {
        // wait_inf → off (release both holds)
        clearAfk(sd);
        clearUserGrace(sd);
    }
}

/** #627 — read the AFK file and derive {mode, expiryMs} for the LoopState
 *  service. File format mirrors the proxy's `_afk_mode` :
 *    absent / empty / "inf" → mode "wait_inf" if "inf", "off" if absent
 *    parseable ISO ts > now → ("wait_10m", expiry)
 *    parseable ISO ts ≤ now → "off" (auto-expired)
 *    unparseable content    → "wait_inf" (degrade to held rather than
 *                              clear silently)
 *  Note: a missing file is "off". An empty file is unusual — the proxy
 *  clears it on read (#622). Here we treat empty as off to align. */
export function readAfkState(sd: string): { mode: "off" | "wait_10m" | "wait_inf"; expiryMs: number | null } {
    const p = afkPath(sd);
    if (!existsSync(p)) return { mode: "off", expiryMs: null };
    let content = "";
    try { content = readFileSync(p, "utf8").trim(); } catch { return { mode: "off", expiryMs: null }; }
    if (content === "") return { mode: "off", expiryMs: null };
    if (content === "inf") return { mode: "wait_inf", expiryMs: null };
    const until = new Date(content).getTime();
    if (Number.isNaN(until)) return { mode: "wait_inf", expiryMs: null };
    if (until <= Date.now()) return { mode: "off", expiryMs: null };
    return { mode: "wait_10m", expiryMs: until };
}

/** #627 — read every state-dir marker + env knob into a `LoopStateInput`
 *  the central `computeLoopView` (loop-state.ts) consumes. Pure read,
 *  no mutation. The only caller-supplied opt left is `manualWake` (a
 *  per-invocation flag, not external state) — every other signal is a
 *  marker (#624 david `62ys4g`). */
export function readLoopStateInput(
    sd: string,
    opts: { manualWake?: boolean } = {},
): import("./loop-state.js").LoopStateInput {
    const nowMs = Date.now();
    const startMs = loopStartMs(sd);
    // #624 david `8pwvm3` : `bootGraceMs` is now a safety cap — the
    // authoritative end-of-boot is `bootComplete` (set via
    // `setResumePicker(sd, false)` by session-start-hook). Bumped to
    // 5 min so a slow resume picker never trips it.
    const bootGraceMs = Math.max(0, Number(process.env[CL_ENV.BOOT_GRACE_SEC] ?? 300)) * 1000;
    // #629 david `2hwuan` : floor INVIOLABLE 30 s par défaut. cli.ts exporte
    // le yaml `claude_loop.boot_min_seconds` via cette env var.
    const bootMinMs = Math.max(0, Number(process.env[CL_ENV.BOOT_MIN_SEC] ?? 30)) * 1000;
    // #647 Slice 2 : resumePickerActive = OR des deux nouveaux markers.
    // Conserve la sémantique "any resume picker is up" pour les consommateurs
    // existants ; la distinction session vs mode est exposable via les
    // chemins dédiés (resumeSessionPickerActivePath / resumeModePickerActivePath)
    // pour les futurs consommateurs (bar slice 4).
    const resumePickerActive = existsSync(resumeSessionPickerActivePath(sd))
        || existsSync(resumeModePickerActivePath(sd));
    const bootComplete = existsSync(bootCompletePath(sd));
    const noWait = process.env[CL_ENV.WAIT] === "0";
    // user-grace window = max(user, ask) for back-compat with projects
    // that still set ask_grace_seconds in .aiball.yaml (#619 collapse).
    const userGraceSec = Math.max(
        Number(process.env[CL_ENV.USER_GRACE_SEC] ?? DEFAULT_USER_GRACE_SEC),
        Number(process.env[CL_ENV.ASK_GRACE_SEC] ?? DEFAULT_ASK_GRACE_SEC),
        0,
    );
    const wakeInFlightTtlMs = Math.max(0, Number(process.env[CL_ENV.WAKE_IN_FLIGHT_TTL_MS] ?? 2000));

    function safeMtime(p: string): number | null {
        try { return existsSync(p) ? statSync(p).mtimeMs : null; } catch { return null; }
    }
    function safeIsoMs(p: string): number | null {
        try {
            if (!existsSync(p)) return null;
            const v = new Date(readFileSync(p, "utf8").trim()).getTime();
            return Number.isNaN(v) ? null : v;
        } catch { return null; }
    }

    const afk = readAfkState(sd);
    return {
        nowMs,
        loopStartMs: startMs,
        bootGraceMs,
        bootMinMs,
        resumePickerActive,
        bootComplete,
        paneBusy: existsSync(paneBusyPath(sd)),
        paneReady: existsSync(paneReadyPath(sd)),
        paneCompacting: existsSync(paneCompactingPath(sd)),
        paneInterrupted: existsSync(paneInterruptedPath(sd)),
        noWait,
        humanTypingAtMs: safeMtime(humanTypingPath(sd)),
        humanTypingTtlMs: HUMAN_TYPING_TTL_SEC * 1000,
        userTookOverAtMs: safeMtime(userTookOverPath(sd)),
        userGraceMs: userGraceSec * 1000,
        afkMode: afk.mode,
        afkExpiryMs: afk.expiryMs,
        idleSinceMs: safeMtime(idleMarkerPath(sd)),
        wakeInFlightAtMs: safeMtime(wakeInFlightPath(sd)),
        wakeInFlightTtlMs,
        busyDeferUntilMs: safeIsoMs(busyDeferUntilPath(sd)),
        manualWake: opts.manualWake ?? false,
    };
}

/**
 * #264: short TTL for the near-live "human typing" chip. The detection
 * poll refreshes the marker while the human types; once they stop, the
 * chip lingers ~this long then clears. Kept short so the bar tracks
 * typing closely (vs the 60s submit-grace of user-took-over).
 */
export const HUMAN_TYPING_TTL_SEC = 5;

/** Is the pane really running under the PTY proxy right now? (#269)
 *  The proxy drops the marker (stamped with its PID, see pty-proxy.py) after
 *  a successful fork and unlinks it at cleanup. Existence alone was the fact
 *  — but a proxy killed with -9 (or OOM'd) never runs cleanup, so the stale
 *  marker pinned `proxyIsAlive` true forever: TS kept abdicating `@cl_human`
 *  to a dead proxy that could no longer paint it, freezing the bar on a bare
 *  `claude-` (#278). So verify the stamped PID is actually alive; a dead/
 *  missing/legacy-unstamped marker hands the segment back to TS degraded
 *  painting. */
export function proxyIsAlive(sd: string): boolean {
    const p = proxyAlivePath(sd);
    let raw: string;
    try {
        raw = readFileSync(p, "utf8");
    } catch {
        return false; // no marker → not under the proxy
    }
    const pid = Number.parseInt(raw.trim(), 10);
    // Legacy markers (pre-PID stamp) → fall back to existence so we never
    // drop a genuinely-live proxy's segment on the format change alone.
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0); // signal 0 = liveness probe, sends nothing
        return true;
    } catch (e) {
        // ESRCH = the process is gone; EPERM = alive but not ours (still up).
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Is a human typing in the pane right now (within the TTL)? (#264) */
export function humanIsTyping(sd: string, ttlSec = HUMAN_TYPING_TTL_SEC): boolean {
    const p = humanTypingPath(sd);
    if (!existsSync(p)) return false;
    try {
        return (Date.now() - statSync(p).mtimeMs) < ttlSec * 1000;
    } catch {
        return false;
    }
}

/** #585 — composite "human present right now" gate: recent user-grace activity
 *  OR keystrokes happening this very moment. Single source so the definition
 *  of presence stays in lock-step across timer/stop-hook/pretooluse-hook. */
export function humanPresent(sd: string, graceSec: number): boolean {
    return userIsTakingOver(sd, graceSec) || humanIsTyping(sd);
}

/**
 * Lightweight tmux status-left display. Three states (#B.154 final
 * collapse, david: "busy a pas de sens clair, pour moi busy égal
 * working" → "garde busy"):
 *
 *   - `boot` (yellow) — transitional at spawn, before SessionStart
 *   - `idle` (gray)   — claude at prompt, nothing to drain
 *   - `busy` (green)  — claude is processing (post-prompt, post-
 *     wake, or pane-verified mid-turn via `esc to interrupt`)
 *
 * The previous distinction between `busy` (queued/waiting, cyan) and
 * `working` (verified active, green) was academic — from the user's
 * point of view, "we sent something to claude" is the same as
 * "claude is doing something". One green `busy` state, simpler.
 *
 * Transient phase suffixes still rendered via setTmuxStatus's third
 * arg: `[busy:compacting]`, `[busy:rate-limit]`, `[boot:resume?]`.
 *
 * No-op when tmux is gone (loop was just rm'd) — never throw.
 */
export type LoopStatus = "idle" | "boot" | "busy";

// #584 — const enum companion. Callers pass `LOOP_STATUS.BOOT` instead of the
// raw `"boot"` literal so a typo like `"bot"` is caught at compile time.
export const LOOP_STATUS = {
    IDLE: "idle",
    BOOT: "boot",
    BUSY: "busy",
} as const satisfies Record<string, LoopStatus>;

// #385 (david wstfea): the bar colour profile is config-driven (defaults →
// global `~/.config/aiball/config.yaml` → per-project `.aiball.yaml`, resolved in
// autopoll/config.ts). Memoised per-process — colours never change mid-session,
// and setTmuxStatus runs in short-lived hook processes (one resolve each) + the
// long-lived timer (resolved once). The default palette keeps the #B.154 state
// backgrounds (busy electric-blue / idle grey / boot yellow); what changed is
// that the bar text sits on TWO backgrounds with TWO foregrounds: `island_fg`
// (light) on the black island, `bar_fg` (now black) on the state-coloured region
// — david's bar runs the busy-blue state where white washed out.
/**
 * #481 : résolution du cwd projet pour `loadConfig()` côté loop. Source
 * de vérité = `plate.json:cwd` (écrit au `claude-loop start`, autorité
 * canonique lue partout ailleurs). Mémoïsé : on lit le plate UNE fois
 * — il ne change pas pendant la vie du process.
 *
 * Niveaux de priorité (descendant) :
 *   1. `process.env.AIBALL_PROJECT_CWD` — override haute priorité (debug
 *      / tests qui setent l'env sans plate). David `cue7nr` : "purement
 *      optionnel tweak".
 *   2. `plate.json:cwd` via `process.env.CL_STATE_DIR` — la source en
 *      régime normal.
 *   3. `process.cwd()` — dernier recours (loops d'avant cette version,
 *      tests purs qui ne setent ni l'un ni l'autre).
 */
export type ProjectCwdInfo = {
    cwd: string;
    source: "env" | "plate" | "cwd";
    state_dir?: string;
    plate_path?: string;
};

// Pure (no cache): same 3-level resolution as projectCwd(), but returns
// the breakdown so reporters (`claude-loop check`, `claude-loop status`)
// can surface WHICH source won.
export function projectCwdInfo(): ProjectCwdInfo {
    const envOverride = process.env.AIBALL_PROJECT_CWD;
    if (envOverride) return { cwd: envOverride, source: "env" };
    const sd = process.env[CL_ENV.STATE_DIR];
    if (sd) {
        try {
            const plate = readPlate(sd);
            if (plate.cwd) {
                return { cwd: plate.cwd, source: "plate", state_dir: sd, plate_path: platePath(sd) };
            }
        } catch { /* missing/corrupt plate — fall through */ }
    }
    return { cwd: process.cwd(), source: "cwd" };
}

let PROJECT_CWD_CACHED: string | null = null;
function projectCwd(): string {
    if (PROJECT_CWD_CACHED) return PROJECT_CWD_CACHED;
    PROJECT_CWD_CACHED = projectCwdInfo().cwd;
    return PROJECT_CWD_CACHED;
}

let BAR_COLORS: AiballConfig["colors"] | null = null;
function barColors(): AiballConfig["colors"] {
    // #480 / #481 : cwd projet via plate.json (source unique) avec
    // override env `AIBALL_PROJECT_CWD` et fallback `process.cwd()`.
    if (!BAR_COLORS) BAR_COLORS = loadConfig(projectCwd()).colors;
    return BAR_COLORS;
}
const stateBg = (col: AiballConfig["colors"], s: LoopStatus): string =>
    s === "busy" ? col.busy_bg : s === "boot" ? col.boot_bg : col.idle_bg;

// #305 + #622 : loop session start in ms-since-epoch. Hooks live for ~ms,
// so reading `Date.now()` at module-load gave them a "boot window always
// fresh" view — `humanPresenceWord` then returned `boot` on every hook
// invocation (degraded mode painted the bar permanently boot). Source of
// truth is the `loop-start-ts` file written by `cli.ts` once at launch.
// `PROC_START_MS` (module load) stays as a last-resort fallback when no
// state-dir is reachable (kept for the rare timer-without-sd path).
const PROC_START_MS = Date.now();
function loopStartMs(sd: string | undefined): number {
    if (!sd) return PROC_START_MS;
    try {
        const v = parseInt(readFileSync(loopStartTsPath(sd), "utf8").trim(), 10);
        return Number.isFinite(v) && v > 0 ? v : PROC_START_MS;
    } catch {
        return PROC_START_MS;
    }
}

/**
 * #302/#305: the 3-state human-presence WORD for the tmux bar (`@cl_human`),
 * symmetric with the gating semantics david asked to surface:
 *   - `stop` (red colour196)    — a human is typing NOW (human-typing < 5s)
 *   - `wait` (yellow colour178) — auto-pings FROZEN: either the boot-grace
 *                                 window at launch (#305) OR the user-grace
 *                                 window after a submit (user-took-over < graceSec)
 *   - `loop` (green colour40)   — autonomous, gate open (managed mode)
 * fg-only (the bg comes from status-bg / the loop state). Mirrored in
 * pty-proxy.py, which OWNS this segment while the proxy is alive — keep the
 * two in sync.
 */
/**
 * #310/#426: the bare presence WORD (`stop` / `wait` / `boot` / `loop`), decoupled
 * from the tmux colour formatting so the SAME logic feeds both the bar
 * (humanBarWord below) and the heartbeat push to the consumers page
 * (timer.ts → pushState). Keep in sync with pty-proxy.py's _rest_word.
 *   - `stop` — a human is typing NOW (human-typing < 5s)
 *   - `boot` — launch window (#305 boot-grace) ; claude still loading,
 *              auto-pings frozen
 *   - `wait` — auto-pings FROZEN: user-grace window after a submit OR AFK
 *              marker armed
 *   - `loop` — autonomous (managed mode), incl. --no-wait
 */
export function humanPresenceWord(sd: string | undefined, _graceSec: number): "stop" | "wait" | "boot" | "loop" {
    // #627 — delegate to the central LoopState service so the bar word
    // computation matches the one used by every other consumer (timer,
    // proxy mirror, hooks). The `graceSec` arg is preserved for API
    // back-compat but unused here — the service reads user_grace from
    // the env (CL_USER_GRACE_SEC + CL_ASK_GRACE_SEC max).
    if (!sd) return "loop";
    return computeLoopView(readLoopStateInput(sd)).barWord;
}

export function humanBarWord(sd: string | undefined, graceSec: number): string {
    // #302 david: black bg (colour16) behind the word so it stays readable over
    // any bar state colour (busy blue / idle gray / boot yellow). fg encodes the
    // word: stop=red / wait=yellow / boot=yellow / loop=green. Logic lives in
    // humanPresenceWord. All four words are 4 chars so pad-to-4 keeps the bar
    // width constant by accident.
    const word = humanPresenceWord(sd, graceSec);
    const fg = word === "stop" ? "colour196"
        : word === "wait" || word === "boot" ? "colour178"
        : "colour40";
    return `#[fg=${fg},bg=colour16]${word.padEnd(4)}`;
}

export function setTmuxStatus(
    name: string,
    status: LoopStatus,
    countOrInfo?: number | string,
): void {
    // #B.149/#B.154: optional unread-ping count OR free-form phase
    // info appended to the status label. count → `[idle 3]`. info
    // → `[boot:picker?]`. Lets the bar carry transient diagnostic
    // state without inventing new colors per phase. David: "la
    // barre tmux peut etre utilisé pour afficher le mode (dialogue
    // detecté etc)".
    let tag = `[${status}]`;
    if (typeof countOrInfo === "number" && countOrInfo > 0) {
        tag = `[${status} ${countOrInfo}]`;
    } else if (typeof countOrInfo === "string" && countOrInfo) {
        tag = `[${status}:${countOrInfo}]`;
    }
    const tn = tmuxName(name);
    const col = barColors();
    const bg = stateBg(col, status);
    const sd = process.env[CL_ENV.STATE_DIR];
    const proxyAlive = !!sd && proxyIsAlive(sd);
    // #627 + #624 david `knb52u` : pendant la fenêtre boot-grace, le BG
    // reste `[boot]` jaune. Les hooks (stop / user-prompt-submit) qui
    // appellent `setTmuxStatus(IDLE, "user")` ou `setTmuxStatus(BUSY)`
    // au milieu du resume picker créaient le mismatch BG gris/blue +
    // word `boot`. settleBoot du timer est la seule autorité pour
    // sortir du BG `[boot]`. `BOOT` lui-même reste toujours peignable
    // (seed cli.ts, settleBoot's own paint, hooks BOOT info update).
    if (sd && status !== "boot" && !canFlipBgFromBoot(readLoopStateInput(sd))) {
        // Skip silencieux — settleBoot fera la transition propre.
        return;
    }
    const setOpt = (opt: string, val: string) =>
        spawnSync(MUX_CMD, ["set-option", "-t", tn, opt, val], { stdio: "ignore" });

    // #274: `status-left` is a STATIC format that references per-owner tmux
    // user-options. The PTY proxy repaints `@cl_human` INSTANTLY on the
    // first keystroke (it owns that segment while alive — see pty-proxy.py);
    // TS owns the rest. The bar's bg comes from `status-bg` (set per state
    // below), so the proxy's fg-only `@cl_human` renders on the current
    // state colour without the proxy ever knowing it. The fg is reset to
    // `bar_fg` (#385 colour profile, black by default) after the human/proxy
    // segments so `name [state]` reads on the coloured bar.
    // `#{@cl_human}` carries the human-presence WORD (loop/stop, painted by
    // the proxy live or by the degraded-mode block below). It can be empty
    // for a beat — proxy forked but hasn't painted yet, CL_TMUX unset so the
    // proxy's paint no-ops, or a state race — and an empty option rendered a
    // bare `claude-` (#278). Default it to the autonomous `loop` word at the
    // FORMAT level so the bar always reads at least `claude-loop`; a real
    // painted value (loop/stop) still wins via the conditional.
    //
    // #302 (gmwffh) layout: the bar OPENS in the active state colour, a
    // shade-block GRADIENT fades active→black (`▓▒░`), then a black `island`
    // holds ` claude-WORD `, then a gradient fades black→active (`░▒▓`), then
    // the rest of the bar resumes in the state colour. No more ` · ` separator.
    // david (gmwffh) wanted a "bande sportive / dégradé" feel, not the sharp
    // half-block edge. Shade blocks (Block Elements, U+2591/2/3) over powerline
    // PUA glyphs so the gradient renders without a Nerd-patched font: each cell
    // is fg=active over bg=black, ▓=75% / ▒=50% / ░=25% active → smooth fade.
    setOpt(
        "status-left",
        // #302: commas inside the false-branch `#[…]` MUST be escaped `#,` —
        // tmux splits `#{?cond,then,else}` on commas, so an unescaped one broke
        // the `loop` fallback entirely (the #278 bare-`claude-` guard never
        // actually fired). Escaped, the fallback renders when @cl_human is unset.
        // #381 → #385 (david qyqwnw): the control-key hint moved OFF the left
        // island to `status-right` (seeded in cli.ts: `AFK:<KEY> · DETACH:<prefix> d`).
        // The status-left format below no longer carries `@cl_keys`; a leftover
        // @cl_keys on a session started before this change is simply never
        // referenced now (harmless — no literal renders).
        `#[bg=${bg}] #[fg=${bg},bg=colour16]▓▒░#[fg=${col.island_fg}] claude-#{?@cl_human,#{@cl_human},#[fg=colour40#,bg=colour16]loop} #[fg=${bg},bg=colour16]░▒▓#[bg=${bg}]#{@cl_proxy}#[fg=${col.bar_fg}] ${name} #{@cl_state} `,
    );
    setOpt("status-bg", bg);
    setOpt("status-fg", col.bar_fg);
    // Loop-state tag (#B.149/#B.154): `[idle 3]` / `[boot:resume?]` etc.
    setOpt("@cl_state", `#[fg=${col.bar_fg}]${tag}`);
    // #269 (tcn5ej): discreet ⇄ when the pane really runs under the proxy
    // (ground truth = proxy-alive marker). Absent ⇒ direct-launch fallback.
    setOpt("@cl_proxy", proxyAlive ? `#[fg=colour250] ⇄` : "");
    // #264/#302 human-presence WORD (3 états): `stop` (red) human typing /
    // `wait` (yellow) user-grace window, auto-pings frozen / `loop` (green)
    // autonomous gate-open. The proxy owns this segment live when present
    // (instant, busy included); in DEGRADED mode (no proxy) TS paints it
    // from the markers — skipped when the proxy is alive so the two never
    // fight over it.
    if (!proxyAlive) {
        const graceSec = Math.max(0, Number(process.env[CL_ENV.USER_GRACE_SEC] ?? DEFAULT_USER_GRACE_SEC));
        const word = humanBarWord(sd, graceSec);
        setOpt("@cl_human", word);
        logBarPaint(sd, `state.ts:setTmuxStatus(${status})`, word);
    }
}

/**
 * Read the loop's pings YAML and return one phrase at random. Falls
 * back to "ping" on any read/parse failure so the wake-up always
 * delivers SOMETHING — the wrapper's job is to poke claude, not to
 * be picky about which phrase. Shared by the timer (per-tick wake)
 * and the CLI startup nudge (#B.63 follow-up: same source for both).
 */
/**
 * True iff the last few non-empty lines of `paneText` contain Claude
 * Code's "esc to interrupt" footer — i.e. claude is mid-turn.
 *
 * Scoped to the footer (default last 5 lines) so a stale occurrence
 * earlier in scrollback can't pin "busy" forever once the prompt
 * returns (#B.185). Shared by the heartbeat timer, the claude-loop
 * Stop hook, and the autopoll Stop hook (#B.192).
 */
export function paneFooterShowsBusy(paneText: string, footerLines = 5): boolean {
    const footer = paneText
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-footerLines)
        .join("\n");
    return /esc to interrupt/i.test(footer);
}

/**
 * True iff the visible pane shows Claude Code's "interrupted by user"
 * notice (#345 B) — i.e. the human pressed ESC and claude bailed out
 * mid-turn, leaving a half-done state once the prompt returns. Used to
 * decorate the bar as `[idle:interrupted]` (no 4th LoopStatus — just a
 * `:special` suffix, like `idle:user` / `idle:wait`).
 *
 * ⚠️ #345 : la chaîne EXACTE rendue par Claude Code n'est pas encore
 * confirmée sur capture réelle (aucune fixture dans le repo ; au moment
 * du dev les sessions live étaient busy/idle, pas interrompues). On
 * matche le marqueur standard « interrupted by user » (couvre aussi
 * « Request interrupted by user »), avec un scope élargi (12 dernières
 * lignes non vides, vs 5 pour `busy`) car la notice remonte au-dessus du
 * prompt rendu. À confirmer/affiner via #360 (le logger proxy) ou une
 * capture d'interruption réelle. C'est de la DÉCORATION pure : un faux
 * négatif retombe sur `[idle]`, un faux positif sur `[idle:interrupted]`
 * — aucun impact sur le gating des wakes (qui, lui, lit `esc to interrupt`).
 */
export function paneShowsInterrupted(paneText: string, footerLines = 12): boolean {
    const footer = paneText
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-footerLines)
        .join("\n");
    return /interrupted by user/i.test(footer);
}

/**
 * Special INTERNAL pane states (not errors) that should suppress
 * auto-wakes regardless of the `esc to interrupt` mid-turn signal.
 *
 *   - `compacting`  — `/compact` or auto-compact summarizing the
 *     transcript; the next prompt has to wait for it to finish. It
 *     resolves itself, so we just suppress while visible (no backoff).
 *
 * Error states that CRASH the turn (rate-limit, api-error, overloaded)
 * moved out of here to `error-backoff.ts` (#332): they need a dumb
 * exponential backoff + resume, not a flat suppress-while-visible.
 */
export type PaneSpecial = "compacting";

export interface PaneSnapshot {
    /** True iff the pane footer shows `esc to interrupt` — claude is
     *  visually mid-turn. Authoritative claude-busy signal (#B.173). */
    busy: boolean;
    /** Special state if detected; null on a normal/idle pane. */
    special: PaneSpecial | null;
}

/**
 * Classify the internal special state (compacting) visible in the
 * captured pane text. Centralized here (#B.198 david:
 * "fait un etat/funcion/serrvice global qui sert aussi pour le
 * business") so the Stop hook, the timer, and the autopoll hook all
 * agree on what counts as "claude is internally busy and shouldn't
 * be poked". Returns null when nothing special — caller falls through
 * to the regular busy/idle decision.
 *
 * Footer-scoped (default 5 lines) — same fix as #B.185 for
 * `paneFooterShowsBusy`. Without this, stale `✶ Compacting
 * conversation… (42s)` lines left in scrollback after `/compact`
 * finishes keep matching forever and block every wake until the
 * scrollback rolls past them. Live compacting still pins the marker
 * at the bottom of the pane, so footer-scope catches it.
 */
export function classifyPaneSpecial(text: string, footerLines = 5): PaneSpecial | null {
    const footer = text
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-footerLines)
        .join("\n");
    // #650 david `tjab9e` (revised) — discriminant live vs stale. Capture
    // réelle du UI Claude actuel :
    //   `✽ Compacting conversation… (1m 12s)`
    //   `  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 55%`
    // ⇒ pas de `esc to interrupt` (premier essai cassé) — la barre de
    // progression Unicode ▰/▱ OU le percentage `NN%` sont les vrais
    // marqueurs uniques-au-live. Le stale `✶ Compacting conversation…
    // (42s)` n'en a aucun (texte seul, progress effacé quand /compact se
    // termine). On garde `esc to interrupt` en 3e OR pour le rare format
    // sans progress mais avec turn live (legacy / variant rare).
    const hasCompactingText = /Compacting conversation|Summarizing the conversation/i.test(footer);
    const hasProgressBar = /[▰▱]/.test(footer);
    const hasPercent = /\d+\s?%/.test(footer);
    const hasEscInterrupt = /esc to interrupt/i.test(footer);
    const hasLiveSignal = hasProgressBar || hasPercent || hasEscInterrupt;
    if (hasCompactingText && hasLiveSignal) return "compacting";
    // rate-limit / api-error / overloaded are handled by error-backoff.ts
    // (#332) — they're errors, not internal busy states.
    return null;
}

/**
 * Unified pane-state probe — bundles `paneFooterShowsBusy` and
 * `classifyPaneSpecial` into one snapshot. The single source every
 * wake decision should consult so the log line and the business
 * branch never disagree (#B.198). Caller does the `tmux capture-pane`
 * itself (different surfaces use different tmux targets / flags); we
 * only classify what's already in hand.
 */
export function snapshotPane(paneText: string, footerLines = 5): PaneSnapshot {
    return {
        busy: paneFooterShowsBusy(paneText, footerLines),
        special: classifyPaneSpecial(paneText, footerLines),
    };
}

/**
 * One-line summary of a PaneSnapshot suitable for log lines, e.g.
 * `pane=busy:false special=-` or `pane=busy:true special=compacting`.
 * Stable column order so `grep` / `awk` over log files stays trivial.
 */
export function formatPaneSnapshot(snap: PaneSnapshot): string {
    return `pane=busy:${snap.busy} special=${snap.special ?? "-"}`;
}

export function pickPingPhrase(pingsAbsPath: string): string {
    try {
        const raw = readFileSync(pingsAbsPath, "utf8");
        const parsed = parseYaml(raw) as { ping_messages?: unknown };
        const list = Array.isArray(parsed?.ping_messages)
            ? (parsed.ping_messages as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        if (list.length === 0) return "ping";
        return list[Math.floor(Math.random() * list.length)];
    } catch {
        return "ping";
    }
}

/**
 * Wrap a random culture phrase with inline aiball state + a drain
 * directive (#B.221). Used by every wake path that doesn't already
 * have an SSE `WakeHint` to anchor the prompt: session-start,
 * post-turn stop-hook, and the timer's heartbeat fallback. Without
 * this, the wake fires a bare cultural one-liner ("Excellent.",
 * "*tap tap* this thing on?") and claude greets back with no
 * awareness of the pings/tickets sitting in the inbox.
 *
 * Falls back to the plain culture phrase if the daemon is unreachable
 * or both counts come back zero — never blocks the wake on a missing
 * daemon, and never invents a directive when there's nothing to do.
 */
export async function buildContextPhrase(
    client: AiballClient,
    project: string | null,
    pingsAbsPath: string,
): Promise<string> {
    const culture = pickPingPhrase(pingsAbsPath);
    try {
        const [pingsR, projects, headRows, consumerR] = await Promise.all([
            client.pingsCount() as Promise<{ unread?: number }>,
            client.listProjectsDetailed() as Promise<Array<{
                name: string;
                open_count?: number;
                actionable_count?: number;
            }>>,
            // #371: head of the work-order so the wake NAMES the ticket to
            // engage instead of a bare count — kills the recency bias toward
            // the newest.
            // #432: name the CLAIMABLE head (actionable ∩ owned-project), since
            // the directive points at `ticket_engage` which only claims that
            // set. `claimable: "1"` (the API gate matches `=== "1"`, so this
            // actually filters, not just leans on the tiering). The counts below
            // stay actionable/open-inclusive — only the named head narrows.
            // #461: `assume_drained: "1"` predicts the POST-DRAIN head, so the
            // named #X matches what `ticket_engage` returns AFTER the agent
            // drains its pings (the wake CTA always instructs drain BEFORE
            // engage). Without this, the wake's named head is the pre-drain
            // unread-tier top, but the agent's drain demotes it and engage
            // returns a different ticket — the misalignment david flagged.
            // Server-side flag (not client-side sim) so the prediction has
            // access to all ranking signals (priority + own-claim + hot +
            // assignment) and stays accurate as the rules evolve.
            client.listTickets({
                claimable: "1",
                project: project ?? undefined,
                limit: "1",
                assume_drained: "1",
            }) as Promise<Array<{ id: number; title?: string }>>,
            // #397: this loop's own consumer row → its micro_prompt, exposed as
            // the `{consumer_prompt}` placeholder. Best-effort (null on failure).
            client.getConsumer(client.agentId).catch(() => null) as Promise<{ micro_prompt?: string | null } | null>,
        ]);
        const pingCount = typeof pingsR?.unread === "number" ? pingsR.unread : 0;
        // #397: per-consumer standing instruction. Empty when unset → the
        // `{consumer_prompt}` placeholder renders to nothing (opt-in; the
        // operator puts the placeholder in their wake template where they want).
        const consumerPrompt = (consumerR?.micro_prompt ?? "").trim();
        // #374 (#kjsejy): open and actionable are DISTINCT counts. We always
        // state the TRUE open count when waking so a gated backlog (open>0,
        // actionable=0) never reads as "nothing to do"; `actionableCount`
        // drives the engage directive (only point the agent at work in its
        // court). Each falls back to the other for older daemons.
        const sumBy = (key: "actionable_count" | "open_count"): number =>
            Array.isArray(projects)
                ? projects
                    .filter((p) => !project || p.name === project)
                    .reduce((acc, p) => acc + (p[key] ?? p.open_count ?? p.actionable_count ?? 0), 0)
                : 0;
        const actionableCount = sumBy("actionable_count");
        const openCount = sumBy("open_count");
        if (pingCount === 0 && openCount === 0) return culture;

        // #B.232: when BOTH pings and open tickets are pending, chain
        // both directives so the agent doesn't drain pings and stop —
        // david's repro showed `en standby` after a clean drain while
        // 4 open tickets were still actionable. Wording stays imperative
        // ("drain", "engage") on each leg so the agent treats both as
        // tasks, not as informational decoration. The open-tickets leg
        // explicitly says "engage one of N" — earlier wording bottomed
        // out at "handle open via ticket_list" which let me list five
        // tickets and standby (david fqchxa: "l'agent attend encore").
        //
        // Wording rev (#B.232 follow-up, david 6ehkvn): dropped the
        // `[aiball: ...]` bracket framing and the trailing `before
        // answering` because the previous shape tripped prompt-injection
        // defenses on cold claude sessions (a fresh instance refused to
        // invoke ticket_list, reading the bracket+imperative tail as
        // fake-tool-call injection). New shape leads with a conversational
        // lead so backticked tool refs read as casual code mentions, not
        // as directives. Imperative verbs stay intact — they were the
        // actual fix from 0aed5a2.
        //
        // Templating layer (#B.232 cpaez7): wording is no longer
        // hardcoded — slots come from `config/defaults/claude-loop-pings.yaml`
        // (`prompts:` block) with optional per-project override in
        // `.aiball.yaml`. Tone (hint | directive | imperative) drives
        // the russian-doll lookup for object-shape slots. Fallbacks
        // mirror the prior hardcoded wording so a broken yaml still
        // ships a sensible prompt.
        //
        // #480 / #481 : on lit la config à partir du CWD PROJET via
        // `projectCwd()` (plate.json:cwd, source de vérité unique du loop).
        // Sans ça, un loop spawn depuis un autre checkout (typiquement
        // aiball/) tombait sur le `.aiball.yaml` de ce checkout et
        // héritait de ses prompts (wakes m2m en français parce que
        // aiball/.aiball.yaml a un override FR).
        const cfg = loadConfig(projectCwd());
        // #400 recadré (david b296px): tone is back as a SELECTION layer. A slot
        // may carry per-tone buckets `{ <tone>: … }`; renderSlot narrows to
        // slot[tone] (fallback directive). Applied uniformly, not per-placeholder.
        const tone = cfg.autopoll.tone;
        const promptMap = mergePrompts(loadPromptsFromYaml(pingsAbsPath), cfg.prompts);

        // #400: ONE template carries the whole wake via the {x:+…} grammar — no
        // conditional assembly here. Counts pass "" when zero so the matching
        // {count:+…} block drops out. `lead` is its own slot (random pick for
        // variety). All vars are exposed so the yaml `wake_master` is fully
        // overridable per project (#371/#374 wording lives in the template).
        const head = Array.isArray(headRows) ? headRows[0] : undefined;
        const scope = project ? `\`${project}\`` : "your scope";
        // #428: run the configured custom gates (built-in `type` or custom
        // `cmd`). Triggered gates surface their message in the wake; a `blocks`
        // gate also SUPPRESSES the engage directive (actionable_count → "") so
        // the CTA reads "resolve this before taking new work". Fail-open: any
        // gate error → no gate (never breaks the wake).
        let gateResults: ReturnType<typeof runGates> = [];
        try {
            const specs = parseGates((cfg.claude_loop as { gates?: unknown }).gates);
            if (specs.length) gateResults = runGates(specs, process.cwd());
        } catch { /* gates never block the wake */ }
        const blocking = gateResults.some((g) => g.blocks);
        // #516 (david `r59bkm` plan A) — pour un consumer no_claim ou tout
        // contexte où il n'y a pas de head claimable post-drain, l'engage
        // directive doit DISPARAÎTRE (sinon le wake dit "engage # first" avec
        // un id vide — le bug que david/aiball-win ont vu). Le var
        // `actionable_count` reste la jauge informationnelle (combien dans
        // ton camp au sens large), mais le template ne fait fire l'engage
        // que sur HEAD_ID non-vide via `head_id:+ {…}` ; voir wake_master
        // ci-dessous. Empty head → fallback texte qui rappelle juste
        // les unread pings.
        const hasClaimableHead = !!(head?.id);
        const vars = {
            culture,
            lead: renderSlot(promptMap, "wake_lead", {}, "fyi:", tone),
            ping_count: pingCount || "",
            open_count: openCount || "",
            // #428: a blocking gate hides the engage directive ("don't take new work").
            // #516 : aussi caché quand pas de head claimable post-drain.
            actionable_count: (blocking || !hasClaimableHead) ? "" : (actionableCount || ""),
            head_id: head?.id ?? "",
            head_title: head?.title ?? "",
            project_scope: scope,
            // #397: {consumer_prompt} = this consumer's micro-prompt (opt-in;
            // empty → renders to nothing). David puts the placeholder in his
            // wake_master override where he wants it.
            consumer_prompt: consumerPrompt,
        };
        const cta = renderSlot(
            promptMap,
            "wake_master",
            vars,
            "{culture} {lead}"
            + "{ping_count:+ {ping_count} unread aiball ping(s) — drain via `unread({pings: true, mark_read: true})`.}"
            + "{actionable_count:+ engage #{head_id} first — top of the work order — via `ticket_engage()`.}"
            + "{open_count:+{actionable_count:+ }[{open_count} open]}",
            tone,
        );
        // #428: prepend the triggered-gate banner. Built-in messages render via
        // their prompt slot (per-project overridable + tone-aware + {vars});
        // custom gates use their literal message / cmd stdout. Template-agnostic
        // (works even when a custom wake_master has no {gates} placeholder).
        if (gateResults.length === 0) return cta;
        const banner = gateResults
            .map((g) => (g.slot ? renderSlot(promptMap, g.slot, g.vars, g.message, tone) : g.message))
            .join("  ");
        return `${blocking ? "🛑 " : ""}${banner}  ${cta}`;
    } catch {
        return culture;
    }
}

/**
 * Inject a wake phrase into a tmux pane so Claude Code's TUI submits
 * it as a single user prompt (#B.221 follow-up).
 *
 * Why this isn't just `send-keys <phrase> Enter`: when `<phrase>` is
 * long (the new #B.221 state-CTA is ~130 chars), Claude Code's input
 * handler appears to treat the fast send-keys burst as a paste and
 * swallows the trailing Enter as paste-content rather than submit,
 * leaving the text stuck in the prompt area. David's repro on
 * #221 comment 9e76jx: "n'envoie pas enter et reste dans le prompt".
 *
 * Robust pattern (mirrors `tryPanic`): write the phrase into a tmux
 * paste-buffer, paste it (bracketed paste — explicit start/end so the
 * TUI knows the paste closed), sleep briefly for the prompt to
 * repaint, then send a standalone Enter. Falls back to plain
 * `send-keys <phrase>` if `set-buffer` failed (extremely rare).
 *
 * Used by every wake site: session-start-hook, stop-hook post-turn
 * wake, timer no-hint wake, and SSE-hinted wakes — short phrases pay
 * a ~200ms latency but consistency beats branching on length.
 */
export async function injectWakePhrase(paneTarget: string, phrase: string): Promise<void> {
    // #269: when the pane runs under the PTY proxy, deliver the wake
    // straight to claude's PTY via the proxy's control channel — that
    // bypasses tmux/psmux stdin, so the proxy's human-typing detector
    // never mistakes our own injection for a human keystroke (#efuuau).
    // Fall back to the tmux paste/send-keys path for loops not under the
    // proxy or if the write fails.
    const sd = process.env[CL_ENV.STATE_DIR];
    // #409/#623 : cross-process counter at the single injection chokepoint
    // — any wake within WAKE_COALESCE_WINDOW_MS of a prior fire collapses
    // (david's "compteur, pas file" model). Marker written before inject.
    if (sd && skipDuplicateWakeInjection(sd, phrase)) return;
    if (sd) {
        if (process.platform === "win32") {
            // #281 strategy B: Windows uses a named pipe. It can't be
            // stat'd, so gate on the proxy-alive PID marker instead of
            // existsSync(); a dead/absent proxy → fall through to send-keys.
            if (proxyIsAlive(sd)) {
                const pipe = injectPipeName(sd);
                if (await injectViaSocket(pipe, phrase)) return;
            }
        } else {
            const sock = injectSockPath(sd);
            if (existsSync(sock) && await injectViaSocket(sock, phrase)) return;
        }
    }
    const bufName = `wake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const setBuf = spawnSync(MUX_CMD, ["set-buffer", "-b", bufName, phrase], { stdio: "ignore" });
    if (!setBuf.error && setBuf.status === 0) {
        spawnSync(MUX_CMD, ["paste-buffer", "-b", bufName, "-d", "-t", paneTarget], { stdio: "ignore" });
    } else {
        spawnSync(MUX_CMD, ["send-keys", "-t", paneTarget, phrase], { stdio: "ignore" });
    }
    await new Promise<void>((res) => setTimeout(res, 200));
    spawnSync(MUX_CMD, ["send-keys", "-t", paneTarget, "Enter"], { stdio: "ignore" });
}

/**
 * #627 — persistent UDS connection from the timer to the PTY proxy's
 * view-push socket. The timer holds one connection open ; each call to
 * `push(view)` sends a newline-delimited JSON line. On any error
 * (proxy gone, socket dropped) we close, mark the connection dead, and
 * the next `push()` will reconnect. Pure best-effort : no view loss is
 * fatal (the proxy keeps the last pushed view + falls back to its
 * local rules until the next push lands).
 */
export interface ViewPusher {
    push(view: import("./loop-state.js").LoopStateView): void;
    close(): void;
}

export function createViewPusher(sockPath: string): ViewPusher {
    let sock: ReturnType<typeof netConnect> | null = null;
    let connecting = false;
    let queued: string[] = [];

    const connect = (): void => {
        if (sock || connecting) return;
        connecting = true;
        try {
            const s = netConnect(sockPath);
            s.on("error", () => {
                try { s.end(); } catch { /* ignore */ }
                if (sock === s) sock = null;
                connecting = false;
            });
            s.on("close", () => {
                if (sock === s) sock = null;
                connecting = false;
            });
            s.on("connect", () => {
                sock = s;
                connecting = false;
                // Flush any queued payloads accumulated while we were
                // reconnecting (typically the very first call from
                // settleBoot before the timer's view-watcher started).
                for (const line of queued) {
                    try { s.write(line); } catch { /* ignore */ }
                }
                queued = [];
            });
        } catch {
            connecting = false;
        }
    };

    return {
        push(view) {
            const line = JSON.stringify(view) + "\n";
            if (sock && !sock.destroyed) {
                try { sock.write(line); return; } catch { /* fall through */ }
            }
            // Queue the FIRST few pushes while we (re)connect ; drop
            // anything beyond a cap so a dead proxy doesn't leak memory.
            if (queued.length < 4) queued.push(line);
            connect();
        },
        close() {
            try { sock?.end(); } catch { /* ignore */ }
            sock = null;
            queued = [];
        },
    };
}

/**
 * #633 (Slice A) — server side of the proxy→timer back-channel. The
 * timer binds the UDS at `proxyEventsSockPath(sd)`, accepts one or more
 * proxy connections, parses newline-delimited JSON events, and invokes
 * `onEvent` for each. Errors are swallowed (best-effort) — a dead
 * proxy or malformed line never crashes the timer. The bound server
 * socket is cleaned up on returned `close()`.
 */
export interface ProxyEventsServer {
    close(): void;
}

export function createProxyEventsServer(
    sockPath: string,
    onEvent: (event: Record<string, unknown>) => void,
): ProxyEventsServer {
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* race */ }
    const server = netCreateServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                try {
                    const parsed = JSON.parse(line) as unknown;
                    if (parsed && typeof parsed === "object") {
                        onEvent(parsed as Record<string, unknown>);
                    }
                } catch { /* malformed — skip silently */ }
            }
        });
        conn.on("error", () => { try { conn.end(); } catch { /* ignore */ } });
        conn.on("close", () => { /* connection gone — server stays open */ });
    });
    try { server.listen(sockPath); } catch { /* bind failed — events lost, OK */ }
    server.on("error", () => { /* keep listening on next reconnect attempt */ });
    return {
        close() {
            try { server.close(); } catch { /* ignore */ }
            try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
        },
    };
}

/**
 * #269: write a wake phrase to the PTY proxy's UDS injection socket.
 * Mirrors the tmux dance — phrase, a brief pause for the TUI to settle,
 * then a carriage return to submit. Resolves `false` on any error (so the
 * caller falls back to the tmux path) and never throws.
 */
function injectViaSocket(sockPath: string, phrase: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let sock: ReturnType<typeof netConnect>;
        const finish = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            try { sock?.end(); } catch { /* ignore */ }
            resolve(ok);
        };
        try {
            sock = netConnect(sockPath);
        } catch {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => finish(false), 2000);
        sock.on("error", () => { clearTimeout(timer); finish(false); });
        sock.on("connect", async () => {
            try {
                sock.write(phrase);
                await new Promise<void>((r) => setTimeout(r, 200));
                sock.write("\r");
                await new Promise<void>((r) => setTimeout(r, 30));
                clearTimeout(timer);
                finish(true);
            } catch {
                clearTimeout(timer);
                finish(false);
            }
        });
    });
}

/**
 * Optional context attached to a wake — typically the SSE ping
 * payload (`{ ticket_id, comment_id, comment_hashid, intent }`).
 * When present, the wake phrase names the concrete artifact instead
 * of a random pop-culture line, so claude knows what to poll without
 * re-fetching the inbox (#B.198 david: "vu qu'on connait l'id du
 * comment autant balancé le numéro en disant poll ce ticket — ça
 * sera plus clair que le pop culture ping").
 *
 * Vocab contract: the human-facing ref for a comment is its short
 * `hashid` (e.g. `#agpgpg`), NOT the numeric `_messages.id`. And we
 * only ever "poll" a ticket — never a comment in isolation. The wake
 * phrase respects both rules; `comment_id` (numeric) is kept on the
 * type only for backward-compat with older SSE producers.
 *
 * `intent` is the parent TICKET's intent (panic / request / question /
 * fyi). Lets the wake phrase scale its directiveness — see
 * `buildWakePhrase` + `wake_phrases` in the pings yaml for the
 * per-intent wording.
 */
export interface WakeHint {
    ticket_id?: number;
    comment_id?: number;
    comment_hashid?: string;
    intent?: Intent;
    /**
     * #555 — extrait du body du commentaire qui a déclenché le wake,
     * markdown-strippé + tronqué (cf. `stripMarkdown`). Optionnel : seul le
     * path commentaire le renseigne (le path ticket-only n'a rien à
     * injecter). Utilisé par `buildWakePhrase` pour le token `{body}`.
     * Non persisté dans `lastWakeHintPath` (pas utile pour la coalescence).
     */
    comment_body?: string;
}

/**
 * Per-intent wake-phrase templates loaded from `wake_phrases` in the
 * pings yaml. Two slots per intent so we render a tight sentence
 * whether or not the SSE ping carried a comment hashid.
 *
 * Tokens substituted at render time: `{ticket}` → integer ticket id,
 * `{comment}` → comment hashid WITHOUT the leading `#` (the `#` lives
 * in the template, so YAML authors can change the surface format
 * without touching code).
 */
interface WakeTemplate {
    with_comment: string;
    ticket_only: string;
}
type WakeTemplates = Record<Intent, WakeTemplate>;

/**
 * Hardcoded backstop used when the loop's pings yaml predates the
 * `wake_phrases` block (#B.198 david: "le niveau de directivité est
 * géré en config yaml" — the YAML is authoritative; this fallback
 * only kicks in if the YAML is missing the section, never overrides
 * a YAML that has it). Kept in sync with the defaults shipped in
 * `config/defaults/claude-loop-pings.yaml`.
 */
const DEFAULT_WAKE_TEMPLATES: WakeTemplates = {
    // #B.230: must mention "aiball" explicitly so claude doesn't
    // confuse the ticket id with another tracker (mantis, etc.) when
    // the project has multiple MCP-exposed trackers configured.
    // #555: `{body}` token inséré sur les slots `with_comment` — extrait
    // markdown-strippé du commentaire qui a déclenché le wake. Token
    // resolved à `""` si pas de body (back-compat avec yaml personnalisés
    // sans `{body}` : token absent = no-op). La séquence `{body:+ — "{body}"}`
    // wrap l'extrait entre guillemets séparé par ` — ` pour qu'il se lise
    // comme une citation inline. Pas de newline → la wake-phrase reste un
    // single-liner injecté via `send-keys` (multi-line déclencherait un
    // submit prématuré).
    panic: {
        with_comment: "URGENT: aiball ticket #{ticket} needs you — new comment #{comment}.{body:+ — {body}}",
        ticket_only: "URGENT: aiball ticket #{ticket} needs you.",
    },
    request: {
        with_comment: "Handle aiball ticket #{ticket} — new comment #{comment}.{body:+ — {body}}",
        ticket_only: "Handle aiball ticket #{ticket}.",
    },
    question: {
        with_comment: "aiball ticket #{ticket} waits for your answer — comment #{comment}.{body:+ — {body}}",
        ticket_only: "aiball ticket #{ticket} waits for your answer.",
    },
    fyi: {
        with_comment: "Heads-up on aiball ticket #{ticket} — new comment #{comment}.{body:+ — {body}}",
        ticket_only: "Heads-up on aiball ticket #{ticket}.",
    },
    // #319: feature work. Base wording; buildWakePhrase appends the config-driven
    // branch hint (workflow.hint_branch / hint_worktree) for this intent.
    feature: {
        with_comment: "Build aiball feature ticket #{ticket} — new comment #{comment}.{body:+ — {body}}",
        ticket_only: "Build aiball feature ticket #{ticket}.",
    },
};

const WAKE_INTENTS: readonly Intent[] = ["panic", "request", "question", "fyi", "feature"];

function isWakeTemplate(x: unknown): x is WakeTemplate {
    return !!x && typeof x === "object"
        && typeof (x as WakeTemplate).with_comment === "string"
        && typeof (x as WakeTemplate).ticket_only === "string";
}

/**
 * Load `wake_phrases` from the pings yaml. Returns null when the
 * block is absent or malformed — the caller then falls back to
 * `DEFAULT_WAKE_TEMPLATES`. Best-effort: missing intents inside an
 * otherwise-valid block are backfilled from the defaults so a partial
 * override never crashes the wake.
 */
export function loadWakeTemplates(pingsAbsPath: string): WakeTemplates | null {
    try {
        const raw = readFileSync(pingsAbsPath, "utf8");
        const parsed = parseYaml(raw) as { wake_phrases?: unknown };
        const block = parsed?.wake_phrases as Record<string, unknown> | undefined;
        if (!block || typeof block !== "object") return null;
        const out = { ...DEFAULT_WAKE_TEMPLATES };
        for (const intent of WAKE_INTENTS) {
            const candidate = block[intent];
            if (isWakeTemplate(candidate)) out[intent] = candidate;
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * Build the wake-prompt sent to claude via `send-keys`. Picks the
 * per-intent template from the pings yaml (see `wake_phrases` block,
 * shape in `WakeTemplate`) and interpolates `{ticket}` / `{comment}`.
 * Intent defaults to `request` when the hint doesn't carry one (so
 * the wording stays directive — david: "poll est pas suffisant […]
 * il faut encourager à traiter le pb").
 *
 * Falls back to a random pop-culture phrase from `pingsAbsPath` when
 * there's no ticket id at all (heartbeat re-check, manual wake,
 * startup nudge). David explicitly wants pop-culture preserved for
 * the no-id path ("si on a pas de ticket on continue à pop culture
 * ping (c rigolo)").
 *
 * We deliberately do NOT emit a "Handle comment #…" branch: (a) the
 * unit of work in aiball is a ticket, not a comment, and (b) using
 * the numeric `_messages.id` as a public ref contradicts the aiball
 * vocab (hashid only).
 */
export function buildWakePhrase(hint: WakeHint | undefined, pingsAbsPath: string): string {
    const ticketId = hint?.ticket_id;
    if (!ticketId) return pickPingPhrase(pingsAbsPath);
    const commentHashid = hint?.comment_hashid;
    const intent: Intent = hint?.intent ?? "request";
    const templates = loadWakeTemplates(pingsAbsPath) ?? DEFAULT_WAKE_TEMPLATES;
    const slot = templates[intent] ?? templates.request ?? DEFAULT_WAKE_TEMPLATES.request;
    const tpl = commentHashid ? slot.with_comment : slot.ticket_only;
    // #555 : grammar `{body:+ <text>}` = `<text>` (avec `{body}` ré-injecté)
    // si comment_body est non-vide, "" sinon. Permet aux templates yaml de
    // choisir où placer l'extrait + son habillage (séparateur, quotes…).
    // Substitution faite AVANT le {body} plain pour que les deux formes
    // coexistent (yaml authors peuvent utiliser l'une ou l'autre). Le regex
    // intérieur autorise un `{body}` imbriqué (le seul token légal dans le
    // bloc) pour ne pas couper sur le `}` du body literal.
    const body = (hint?.comment_body ?? "").trim();
    let phrase = tpl
        .replace(/\{ticket\}/g, String(ticketId))
        .replace(/\{comment\}/g, commentHashid ?? "")
        .replace(/\{body:\+((?:[^{}]|\{body\})*)\}/g, (_, text: string) =>
            body ? text.replace(/\{body\}/g, body) : "")
        .replace(/\{body\}/g, body);
    // #319: for `feature` tickets, claude-loop "habille" the wake with a
    // config-driven branch hint (workflow.hint_branch / hint_worktree, from the
    // layered .aiball.yaml). Wording is non-technical + project-tunable
    // (worktree off by default); the "not on main" nudge enforces the
    // no-runtime-switch rule. request/other intents get nothing extra.
    if (intent === "feature") {
        // #480 / #481 : cwd projet via projectCwd() (plate.json source unique).
        const wf = loadConfig(projectCwd()).workflow;
        const where = wf.hint_worktree
            ? "a dedicated worktree + PR"
            : wf.hint_branch
                ? "a dedicated branch + PR"
                : null;
        if (where) phrase += ` 🌿 Feature: build it in ${where}, not on main.`;
    }
    return phrase;
}
