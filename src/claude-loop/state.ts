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
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../autopoll/config.js";
import { AiballClient } from "../client.js";
import type { Intent } from "../domain.js";
import { loadPromptsFromYaml, mergePrompts, pickPrompt } from "../prompt-templates.js";

export const STATE_ROOT = process.env.CLAUDE_LOOP_STATE_ROOT
    ?? join(homedir(), ".claude-loop");

export const MUX_CMD = process.env.MUX_CMD ?? "tmux";

export function stateDirFor(name: string): string {
    return join(STATE_ROOT, name);
}

export function tmuxName(name: string): string {
    return `cl-${name}`;
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
export function pingsPath(sd: string): string { return join(sd, "pings.yaml"); }
export function idleMarkerPath(sd: string): string { return join(sd, "idle-since"); }
export function wakeRequestedPath(sd: string): string { return join(sd, "wake-requested"); }
export function userTookOverPath(sd: string): string { return join(sd, "user-took-over"); }
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
export const WAKE_IN_FLIGHT_TTL_MS = Math.max(0, Number(process.env.CL_WAKE_IN_FLIGHT_TTL_MS ?? 2000));

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
export const WAKE_COALESCE_WINDOW_MS = Math.max(0, Number(process.env.CL_WAKE_COALESCE_WINDOW_MS ?? 3000));

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

/** Delay applied when the visible pane STILL shows `esc to interrupt`
 *  at Stop-hook FIRE time (#B.198 david: "si pane=busy:true on attend
 *  5 secondes de plus pour faire quoi que ce soit"). The Stop hook
 *  fires post-turn so the footer may be stale (#B.185) — we don't
 *  gate forever, just defer the next wake by this much. Realized via
 *  the `busy-defer-until` marker so the gate survives the hook
 *  process exiting (#B.198 david: "le sleep devrait etre loop/state
 *  based pas promise (pour staker oublié c plus facile)"). */
export const PANE_BUSY_DELAY_MS = Math.max(0, Number(process.env.CL_PANE_BUSY_DELAY_MS ?? 5000));

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
    // src/claude-loop/state.ts → up 2 = repo root
    const here = resolve(new URL(".", import.meta.url).pathname);
    return resolve(here, "..", "..");
}

/** Path to the default ping phrases yaml shipped with the install. */
export function defaultPingsPath(): string {
    return join(installRoot(), "skill", "claude-loop-pings.yaml");
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
    openCount: number;
}
export async function checkHasWork(
    checkCmd: string | null | undefined,
    client?: AiballClient,
    project?: string | null,
    sd?: string | null,
): Promise<CheckHasWorkResult> {
    const cmd = checkCmd ?? "";
    if (cmd === "true") return { has: true, pingsCount: 0, openCount: 0 };
    if (cmd === "" || cmd === LEGACY_AIBALL_CHECK_CMD) {
        const c = client ?? new AiballClient();
        try {
            const [pingsR, projects] = await Promise.all([
                c.pingsCount() as Promise<{ unread?: number }>,
                c.listProjectsDetailed().catch(() => []) as Promise<Array<{
                    name: string;
                    open_count?: number;
                    actionable_count?: number;
                }>>,
            ]);
            const pingsCount = pingsR.unread ?? 0;
            const openCount = Array.isArray(projects)
                ? projects
                    .filter((p) => !project || p.name === project)
                    .reduce((acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0), 0)
                : 0;
            if (pingsCount > 0) return { has: true, pingsCount, openCount };
            // Open-tickets leg: gate by watermark when sd is available
            // so the same N idle tickets don't wake every heartbeat.
            if (sd) {
                const watermark = readLastOpenWakeCount(sd);
                if (openCount < watermark) {
                    // Tickets were closed — lower the watermark so a
                    // future climb correctly re-triggers. Best-effort.
                    recordOpenWakeCount(sd, openCount);
                    return { has: false, pingsCount, openCount };
                }
                return { has: openCount > watermark, pingsCount, openCount };
            }
            return { has: openCount > 0, pingsCount, openCount };
        } catch {
            return { has: false, pingsCount: 0, openCount: 0 };
        }
    }
    const r = spawnSync("bash", ["-c", cmd], { stdio: "ignore" });
    return { has: r.status === 0, pingsCount: 0, openCount: 0 };
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
 * #B.185). When the user has typed a prompt within this window, the
 * timer skips its wake so the wrapper doesn't `send-keys` over a
 * human-driven session. 60s aligns with the heartbeat / boot grace —
 * david: "recalibre les defaut du meme ordre de grandeur". Tunable
 * via `CL_USER_GRACE_SEC`.
 */
export const DEFAULT_USER_GRACE_SEC = 60;

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

const STATUS_COLORS: Record<LoopStatus, { bg: string; fg: string }> = {
    // #B.154 david: "la couleur de busy c'est bleu electrique
    // (le vert est pas clair en signal)". colour33 = vivid blue
    // (~#0087ff), more readable as an active-state signal than the
    // previous green and the original cyan.
    busy: { bg: "colour33",  fg: "colour15" },  // electric blue / white (claude processing)
    idle: { bg: "colour240", fg: "colour15" },  // dark gray / white (at prompt)
    boot: { bg: "colour178", fg: "colour15" },  // yellow / white (transitional)
};

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
    const left = ` CLAUDE-LOOP · ${name} ${tag} `;
    const tn = tmuxName(name);
    const c = STATUS_COLORS[status];
    spawnSync(MUX_CMD, ["set-option", "-t", tn, "status-left", left], { stdio: "ignore" });
    spawnSync(MUX_CMD, ["set-option", "-t", tn, "status-bg", c.bg], { stdio: "ignore" });
    spawnSync(MUX_CMD, ["set-option", "-t", tn, "status-fg", c.fg], { stdio: "ignore" });
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
 * Special pane states surfaced by Claude Code that should suppress
 * auto-wakes regardless of the `esc to interrupt` mid-turn signal.
 *
 *   - `compacting`  — `/compact` or auto-compact summarizing the
 *     transcript; the next prompt has to wait for it to finish.
 *   - `rate-limit`  — Anthropic backend throttling; any new send-keys
 *     just queues uselessly.
 *   - `api-error`   — transient API failure visible to the user; same
 *     reasoning, don't pile on.
 */
export type PaneSpecial = "compacting" | "rate-limit" | "api-error";

export interface PaneSnapshot {
    /** True iff the pane footer shows `esc to interrupt` — claude is
     *  visually mid-turn. Authoritative claude-busy signal (#B.173). */
    busy: boolean;
    /** Special state if detected; null on a normal/idle pane. */
    special: PaneSpecial | null;
}

/**
 * Classify the special states (compacting / rate-limit / api-error)
 * visible in the captured pane text. Centralized here (#B.198 david:
 * "fait un etat/funcion/serrvice global qui sert aussi pour le
 * business") so the Stop hook, the timer, and the autopoll hook all
 * agree on what counts as "claude is internally busy and shouldn't
 * be poked". Returns null when nothing special — caller falls through
 * to the regular busy/idle decision.
 */
export function classifyPaneSpecial(text: string): PaneSpecial | null {
    if (/Compacting|compacting conversation|Summarizing the conversation/i.test(text)) {
        return "compacting";
    }
    if (/Rate limited|temporarily limiting requests/i.test(text)) {
        return "rate-limit";
    }
    if (/API Error|APIError/i.test(text)) {
        return "api-error";
    }
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
        special: classifyPaneSpecial(paneText),
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
        const [pingsR, projects] = await Promise.all([
            client.pingsCount() as Promise<{ unread?: number }>,
            client.listProjectsDetailed() as Promise<Array<{
                name: string;
                open_count?: number;
                actionable_count?: number;
            }>>,
        ]);
        const pingCount = typeof pingsR?.unread === "number" ? pingsR.unread : 0;
        const openCount = Array.isArray(projects)
            ? projects
                .filter((p) => !project || p.name === project)
                .reduce((acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0), 0)
            : 0;
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
        // hardcoded — slots come from `skill/claude-loop-pings.yaml`
        // (`prompts:` block) with optional per-project override in
        // `.aiball.yaml`. Tone (hint | directive | imperative) drives
        // the russian-doll lookup for object-shape slots. Fallbacks
        // mirror the prior hardcoded wording so a broken yaml still
        // ships a sensible prompt.
        const cfg = loadConfig();
        const skillPrompts = loadPromptsFromYaml(pingsAbsPath);
        const promptMap = mergePrompts(skillPrompts, cfg.prompts);
        const tone = cfg.autopoll.tone;

        const parts: string[] = [];
        if (pingCount > 0) {
            // count=pingCount routes to wake_state_pings_one /
            // wake_state_pings_other (#B.232 hd7taf 2-slug
            // pluralization). The plain wake_state_pings slot is the
            // no-variant fallback if the yaml only defines one form.
            parts.push(pickPrompt(promptMap, "wake_state_pings", {
                tone,
                count: pingCount,
                vars: { ping_count: pingCount },
                fallback: `${pingCount} unread aiball ping${pingCount === 1 ? "" : "s"}`,
            }));
        }
        if (openCount > 0) {
            const scope = project ? `\`${project}\`` : "your scope";
            parts.push(pickPrompt(promptMap, "wake_state_open", {
                tone,
                count: openCount,
                vars: {
                    open_count: openCount,
                    project_scope: scope,
                },
                fallback: `${openCount} open aiball ticket${openCount === 1 ? "" : "s"} in ${scope}`,
            }));
        }

        const verbs: string[] = [];
        if (pingCount > 0) {
            verbs.push(pickPrompt(promptMap, "wake_directive_drain", {
                tone,
                vars: { ping_count: pingCount },
                fallback: "drain via `unread({pings: true, mark_read: true})`",
            }));
        }
        if (openCount > 0) {
            verbs.push(pickPrompt(promptMap, "wake_directive_engage", {
                tone,
                vars: { open_count: openCount },
                fallback: `engage one of ${openCount} actionable via \`ticket_list({actionable: true})\``,
            }));
        }
        const directive = verbs.join(" + ");

        const lead = pickPrompt(promptMap, "wake_state_lead", {
            tone,
            fallback: "fyi:",
        });

        return `${culture} ${lead} ${parts.join(" + ")}. ${directive}.`;
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
 * `skill/claude-loop-pings.yaml`.
 */
const DEFAULT_WAKE_TEMPLATES: WakeTemplates = {
    // #B.230: must mention "aiball" explicitly so claude doesn't
    // confuse the ticket id with another tracker (mantis, etc.) when
    // the project has multiple MCP-exposed trackers configured.
    panic: {
        with_comment: "URGENT: aiball ticket #{ticket} needs you — new comment #{comment}.",
        ticket_only: "URGENT: aiball ticket #{ticket} needs you.",
    },
    request: {
        with_comment: "Handle aiball ticket #{ticket} — new comment #{comment}.",
        ticket_only: "Handle aiball ticket #{ticket}.",
    },
    question: {
        with_comment: "aiball ticket #{ticket} waits for your answer — comment #{comment}.",
        ticket_only: "aiball ticket #{ticket} waits for your answer.",
    },
    fyi: {
        with_comment: "Heads-up on aiball ticket #{ticket} — new comment #{comment}.",
        ticket_only: "Heads-up on aiball ticket #{ticket}.",
    },
};

const WAKE_INTENTS: readonly Intent[] = ["panic", "request", "question", "fyi"];

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
    return tpl
        .replace(/\{ticket\}/g, String(ticketId))
        .replace(/\{comment\}/g, commentHashid ?? "");
}
