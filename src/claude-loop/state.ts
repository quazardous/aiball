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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { AiballClient } from "../client.js";

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
}

export function platePath(sd: string): string { return join(sd, "plate.json"); }
export function envPath(sd: string): string { return join(sd, "env"); }
export function pingsPath(sd: string): string { return join(sd, "pings.yaml"); }
export function idleMarkerPath(sd: string): string { return join(sd, "idle-since"); }
export function wakeRequestedPath(sd: string): string { return join(sd, "wake-requested"); }
export function userTookOverPath(sd: string): string { return join(sd, "user-took-over"); }
export function timerPidPath(sd: string): string { return join(sd, "timer.pid"); }
export function timerLogPath(sd: string): string { return join(sd, "timer.log"); }

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
 * Default `--check-cmd` for the timer — gates the per-tick wake on
 * the aiball ping count for the current consumer. Exits 0 when there
 * are unread pings (= ping claude), non-zero when empty (= stay
 * idle). User can override with `--check-cmd '<shell>'`, or pass
 * `--check-cmd true` to ping unconditionally every tick. #B.63 v2.1.
 */
export const DEFAULT_CHECK_CMD = "aiball pings-count -q";

/**
 * The "is there work to drain?" gate used by every wake surface
 * (timer tick + SessionStart hook + Stop hook). #B.63 used to
 * duplicate this across all three callers; #B.141 extracted it
 * here so any tuning (timeout, retry, new fastpath kind) happens
 * once.
 *
 * Behavior:
 *   - Empty / `true` → always wake (legacy "pure timer" mode).
 *   - Default `aiball pings-count -q` → call AiballClient.pingsCount()
 *     in-process (no fork). Caller passes its own cached client to
 *     keep the keep-alive socket warm across ticks.
 *   - Anything else → shell out via `bash -c <cmd>`; exit 0 = work.
 *
 * Async because the in-process path returns a promise. Hooks await
 * it once and exit; the timer awaits it per tick.
 */
export async function checkHasWork(
    checkCmd: string,
    client?: AiballClient,
): Promise<boolean> {
    if (!checkCmd || checkCmd === "true") return true;
    if (checkCmd === DEFAULT_CHECK_CMD) {
        const c = client ?? new AiballClient();
        try {
            const r = await c.pingsCount() as { unread?: number };
            return (r.unread ?? 0) > 0;
        } catch {
            return false;
        }
    }
    const r = spawnSync("bash", ["-c", checkCmd], { stdio: "ignore" });
    return r.status === 0;
}

/**
 * Default user-grace window in seconds (#B.145 v2.2). When the user
 * has typed a prompt within this window, the timer skips its wake so
 * the wrapper doesn't `send-keys` over a human-driven session. Tunable
 * via `CL_USER_GRACE_SEC`.
 */
export const DEFAULT_USER_GRACE_SEC = 300;

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
 * Lightweight "claude is busy / idle" display written into the tmux
 * status-left. Two states only on purpose (#B.144 — david: "debug
 * light, faut pas rendre trop complexe"):
 *
 *   - `idle` → claude is at the prompt with no work pending
 *   - `busy` → claude is in a turn (or we just sent it work)
 *
 * Transitions happen on the same surfaces that drive idle-since:
 * Stop hook + SessionStart hook write `idle`/`busy` depending on
 * checkHasWork; the timer writes `busy` when it sends a wake. The
 * cli writes `busy` at startup so the bar isn't empty until the first
 * hook fires.
 *
 * No-op when tmux is gone (loop was just rm'd) — never throw.
 */
export type LoopStatus = "idle" | "busy" | "boot" | "working";

/**
 * tmux color palette per state (#B.146 / #B.149 / #B.154). David:
 * "la barre tmux devrait etre d'une couleur particulière si claude
 * est en train de travailler (vs idle)". Differentiate:
 *   - `working` (green) — claude actively mid-turn ("esc to
 *     interrupt"). The bar pops to show the user "claude IS doing
 *     stuff right now".
 *   - `busy` (cyan, brand) — scheduled/queued, between turns or
 *     waiting on backend (compacting / rate-limit / api-error).
 *   - `idle` (dark gray) — at prompt, nothing to drain.
 *   - `boot` (yellow) — transitional at spawn, before SessionStart.
 */
const STATUS_COLORS: Record<LoopStatus, { bg: string; fg: string }> = {
    working: { bg: "colour34",  fg: "colour15" },  // green / white (claude mid-turn)
    busy:    { bg: "colour39",  fg: "colour15" },  // cyan / white (queued/waiting)
    idle:    { bg: "colour240", fg: "colour15" },  // dark gray / white
    boot:    { bg: "colour178", fg: "colour15" },  // yellow / white (transitional)
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
