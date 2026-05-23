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
import { connect as netConnect } from "node:net";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig, type AiballConfig } from "../autopoll/config.js";
import { AiballClient } from "../client.js";
import type { Intent } from "../domain.js";
import type { DrainedState } from "./drained-strategy.js";
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

/** #351: default ask-grace (10 min). The AskUserQuestion window — longer
 *  than the wake user-grace (60s) because a stalled question is cheap vs a
 *  lost one. Overridable via `claude_loop.ask_grace_seconds` / CL_ASK_GRACE_SEC. */
export const DEFAULT_ASK_GRACE_SEC = 600;

/** #351: true when the human has flagged AFK and nothing has cleared it.
 *  Existence = active (the proxy deletes the marker on any other keystroke
 *  and on boot). Lets the AskUserQuestion gate redirect even within ask-grace. */
export function afkActive(sd: string): boolean {
    return existsSync(afkPath(sd));
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

// #385 (david wstfea): the bar colour profile is config-driven (defaults →
// global `~/.config/aiball/config.yaml` → per-project `.aiball.yaml`, resolved in
// autopoll/config.ts). Memoised per-process — colours never change mid-session,
// and setTmuxStatus runs in short-lived hook processes (one resolve each) + the
// long-lived timer (resolved once). The default palette keeps the #B.154 state
// backgrounds (busy electric-blue / idle grey / boot yellow); what changed is
// that the bar text sits on TWO backgrounds with TWO foregrounds: `island_fg`
// (light) on the black island, `bar_fg` (now black) on the state-coloured region
// — david's bar runs the busy-blue state where white washed out.
let BAR_COLORS: AiballConfig["colors"] | null = null;
function barColors(): AiballConfig["colors"] {
    if (!BAR_COLORS) BAR_COLORS = loadConfig().colors;
    return BAR_COLORS;
}
const stateBg = (col: AiballConfig["colors"], s: LoopStatus): string =>
    s === "busy" ? col.busy_bg : s === "boot" ? col.boot_bg : col.idle_bg;

// #305: this module is imported by the timer at launch, so its load time ≈
// loop boot for the process that owns setTmuxStatus. humanBarWord's degraded
// (no-proxy) boot-grace branch measures against it — see below.
const PROC_START_MS = Date.now();

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
 * #310: the bare 3-state presence WORD (`stop` / `wait` / `loop`), decoupled
 * from the tmux colour formatting so the SAME logic feeds both the bar
 * (humanBarWord below) and the heartbeat push to the consumers page
 * (timer.ts → pushState). Keep in sync with pty-proxy.py's _rest_word.
 *   - `stop` — a human is typing NOW (human-typing < 5s)
 *   - `wait` — auto-pings FROZEN: boot-grace window (#305) OR user-grace
 *   - `loop` — autonomous (managed mode), incl. --no-wait
 */
export function humanPresenceWord(sd: string | undefined, graceSec: number): "stop" | "wait" | "loop" {
    // #345 D: a present human is reflected even under --no-wait (CL_WAIT=0).
    // NO_WAIT only suppresses the boot-grace `wait` (no human assumed AT
    // LAUNCH); live typing → `stop` and an armed user-grace → `wait` still show.
    if (sd && humanIsTyping(sd)) return "stop";
    const noWait = process.env.CL_WAIT === "0";
    // #305: boot-grace freezes auto-wakes at launch → `wait` during the window,
    // but only when we're actually waiting for a human at boot (not --no-wait).
    const bootGraceMs = Math.max(0, Number(process.env.CL_BOOT_GRACE_SEC ?? 60)) * 1000;
    if (!noWait && Date.now() - PROC_START_MS < bootGraceMs) return "wait";
    if (sd && userIsTakingOver(sd, graceSec)) return "wait";
    return "loop";
}

export function humanBarWord(sd: string | undefined, graceSec: number): string {
    // #302 david: black bg (colour16) behind the word so it stays readable over
    // any bar state colour (busy blue / idle gray / boot yellow). fg encodes the
    // word: stop=red / wait=yellow / loop=green. Logic lives in humanPresenceWord.
    const word = humanPresenceWord(sd, graceSec);
    const fg = word === "stop" ? "colour196" : word === "wait" ? "colour178" : "colour40";
    return `#[fg=${fg},bg=colour16]${word}`;
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
    const sd = process.env.CL_STATE_DIR;
    const proxyAlive = !!sd && proxyIsAlive(sd);
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
        const graceSec = Math.max(0, Number(process.env.CL_USER_GRACE_SEC ?? DEFAULT_USER_GRACE_SEC));
        setOpt("@cl_human", humanBarWord(sd, graceSec));
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
 */
export function classifyPaneSpecial(text: string): PaneSpecial | null {
    if (/Compacting|compacting conversation|Summarizing the conversation/i.test(text)) {
        return "compacting";
    }
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
        const [pingsR, projects, headRows] = await Promise.all([
            client.pingsCount() as Promise<{ unread?: number }>,
            client.listProjectsDetailed() as Promise<Array<{
                name: string;
                open_count?: number;
                actionable_count?: number;
            }>>,
            // #371: head of the FIFO queue (oldest at top priority, after the
            // id-asc sort) so the wake NAMES the ticket to engage instead of a
            // bare count — kills the agent's recency bias toward the newest.
            client.listTickets({
                actionable: "true",
                project: project ?? undefined,
                limit: "1",
            }) as Promise<Array<{ id: number; title?: string }>>,
        ]);
        const pingCount = typeof pingsR?.unread === "number" ? pingsR.unread : 0;
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
            // #374: always state OPEN; append "(N to handle)" when fewer are
            // actionable so a gated backlog stays visible without over-claiming.
            const courtNote = actionableCount < openCount
                ? ` (${actionableCount} to handle)`
                : "";
            parts.push(pickPrompt(promptMap, "wake_state_open", {
                tone,
                count: openCount,
                vars: {
                    open_count: openCount,
                    actionable_count: actionableCount,
                    project_scope: scope,
                },
                fallback: `${openCount} open aiball ticket${openCount === 1 ? "" : "s"} in ${scope}${courtNote}`,
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
        if (actionableCount > 0) {
            // #371: name the FIFO head (head_id/head_title) so the directive
            // points at ONE specific ticket — the oldest at top priority —
            // instead of "one of N" (which let the agent grab the newest).
            // All vars stay exposed so the YAML slot can be overridden
            // per project — count-style or custom flavor (#371 david: les
            // prompts sont pilotés par le yaml, overridables). #374: gated on
            // actionableCount (only engage real work-in-court); open_count
            // exposed too so a slot can mention the wider backlog.
            const head = Array.isArray(headRows) ? headRows[0] : undefined;
            verbs.push(pickPrompt(promptMap, "wake_directive_engage", {
                tone,
                vars: {
                    open_count: openCount,
                    actionable_count: actionableCount,
                    head_id: head?.id ?? "",
                    head_title: head?.title ?? "",
                },
                fallback: head
                    ? `engage #${head.id} first — top of the work order (${actionableCount} in your court) — via \`ticket_list({actionable: true})\``
                    : `engage one of ${actionableCount} actionable via \`ticket_list({actionable: true})\``,
            }));
        }
        const directive = verbs.join(" + ");
        const state = parts.join(" + ");

        const lead = pickPrompt(promptMap, "wake_state_lead", {
            tone,
            fallback: "fyi:",
        });

        // #B.232 jdhdxq: top-level assembly via the `wake_master` slot.
        // Sub-parts (culture / lead / state / directive) ship to the
        // template as vars; `{culture}` also resolves via the `resolve`
        // callback when the template embeds it standalone (so a custom
        // wake_master that uses {culture} inline in addition to / instead
        // of the leading position keeps working). Fallback assembly
        // matches the prior hardcoded layout so a broken yaml still
        // emits a usable wake.
        return pickPrompt(promptMap, "wake_master", {
            tone,
            vars: { culture, lead, state, directive },
            resolve: (key) => key === "culture" ? pickPingPhrase(pingsAbsPath) : undefined,
            fallback: `${culture} ${lead} ${state}. ${directive}.`,
        });
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
    const sd = process.env.CL_STATE_DIR;
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
    // #319: feature work. Base wording; buildWakePhrase appends the config-driven
    // branch hint (workflow.hint_branch / hint_worktree) for this intent.
    feature: {
        with_comment: "Build aiball feature ticket #{ticket} — new comment #{comment}.",
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
    let phrase = tpl
        .replace(/\{ticket\}/g, String(ticketId))
        .replace(/\{comment\}/g, commentHashid ?? "");
    // #319: for `feature` tickets, claude-loop "habille" the wake with a
    // config-driven branch hint (workflow.hint_branch / hint_worktree, from the
    // layered .aiball.yaml). Wording is non-technical + project-tunable
    // (worktree off by default); the "not on main" nudge enforces the
    // no-runtime-switch rule. request/other intents get nothing extra.
    if (intent === "feature") {
        const wf = loadConfig().workflow;
        const where = wf.hint_worktree
            ? "a dedicated worktree + PR"
            : wf.hint_branch
                ? "a dedicated branch + PR"
                : null;
        if (where) phrase += ` 🌿 Feature: build it in ${where}, not on main.`;
    }
    return phrase;
}
