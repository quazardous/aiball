/**
 * claude-loop state management (#B.63 TS port).
 *
 * Each loop has a state dir at `~/.claude-loop/<NAME>/` with:
 * - `plate.json`  — config the timer + stop hook read at runtime
 * - `pings.yaml`  — copy of the wake-up phrases pool (random pick)
 * - `idle-since`  — touched by the Stop hook when claude ends a turn
 * - `wake-requested` — touched by `claude-loop wake` to force next tick
 * - `loop.pid`   — pid of the detached loop process
 * - `loop.log`   — stdout/stderr of the loop
 */
import { spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { DECISION_KINDS, type DecisionKind } from "../decisions.js";
import { listenEvents, sendEventOnce, type EventServer } from "./ipc-events.js";
import { getAfkService } from "./afk-service.js";
import { getTypingService } from "./typing-service.js";
import {
    getIpcState,
    setIpcAfk,
    setIpcBootComplete,
    setIpcBootActiveModules,
    setIpcBusyDeferUntil,
    setIpcDrainedState,
    setIpcHumanTypingAtMs,
    setIpcIdleSince,
    setIpcLastOpenWakeHash,
    setIpcLastWakeHint,
    setIpcPaneBusy,
    setIpcPaneCompacting,
    setIpcPaneInterrupted,
    setIpcPaneReady,
    setIpcPaneResuming,
    setIpcResumeModePicker,
    setIpcResumeSessionPicker,
} from "./ipc-state.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, uptime as osUptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig, type AiballConfig } from "../autopoll/config.js";
import { AiballClient } from "../client.js";
import type { Intent } from "../domain.js";
import type { DrainedState } from "./drained-strategy.js";
import { CL_ENV } from "./env-vars.js";
import { loopConfig } from "./loop-config.js";
import { stripMarkdown } from "./markdown-strip.js";
import { computeLoopView, isHumanPresentHold, isInBootGrace } from "./loop-state.js";
import { classifyCompacting as classifyCompactingRaw } from "./compacting-detector.js";
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
 * #1820 — WHEN the event a wake announces happened.
 *
 * Rendered ONLY past `WAKE_AGE_MIN_MS`, and that threshold is the whole point
 * rather than a tuning detail. Stamping every wake would put a timestamp on
 * events that just happened, the marker would appear everywhere, and it would
 * stop being read. Emitting nothing while the event is fresh makes its mere
 * PRESENCE the signal: this one waited.
 *
 * It matters because a wake speaks the grammar of the urgent. While a human
 * is at the terminal that is fine — everything is fresh. Once the loop runs
 * unattended, what surfaces is backlog, and an undated imperative presents
 * a week-old decision exactly like a one-minute-old one. Two such cases
 * were measured on the same day, both a full week late: a plan acceptance
 * and a human asking whether a ticket could be closed.
 *
 * Absolute rather than relative, on david's call: a wall-clock stamp says
 * exactly when, and stays true wherever it is later re-read — a log, a
 * transcript, a ticket quote. A relative age is only true at the instant it
 * was rendered.
 *
 * Local time on purpose: a loop runs on one machine, for one operator, and
 * `2026-08-20 11:42` is what he can match against his own day.
 */
export const WAKE_AGE_MIN_MS = 60 * 60 * 1000;

export function formatWakeStamp(createdAt: string | null | undefined, nowMs: number): string {
    if (!createdAt) return "";
    const at = Date.parse(createdAt);
    if (!Number.isFinite(at)) return "";
    // Also covers a future timestamp (clock skew between daemon and loop):
    // a negative age is below the threshold, so nothing renders.
    if (nowMs - at < WAKE_AGE_MIN_MS) return "";
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
     * #1549: the claude session this loop is bound to, when running in a
     * managed/fixed `session_mode` (lead) or as a crew (forced managed).
     * Recorded for visibility (`claude-loop list`/`inspect`) — NOT the source
     * of truth: `managed` ids are derived from the loop name, so this survives
     * the state-dir wipe on restart by re-derivation, not by persistence.
     * `null`/absent = `auto` mode (claude picks the session as before).
     */
    session_id?: string | null;
    /** #1549: effective session mode applied at start (auto|managed|fixed). */
    session_mode?: string | null;
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
    /**
     * #1576 — the identity the loop was LAUNCHED with, when it wasn't the one
     * the cwd resolves to on its own.
     *
     * A crew loop is `claude-loop start --cwd <worktree> --role crew --consumer
     * <project>-crew-<name>`: all three live in the launch flags and nowhere
     * else. `restart` rebuilds its invocation from this plate, so without them
     * it came back WITHOUT the crew role and WITHOUT the crew consumer — and
     * `.aiball.yaml` is gitignored, so the worktree has none and the config
     * walk-up lands on the LEAD's. The crew returned able to claim, under the
     * lead's identity, as a project owner.
     *
     * Kept OUT of `remote` on purpose: that block means "this loop talks to a
     * remote daemon", which is orthogonal — a local crew has no remote, and
     * that is exactly why its `--consumer` was being dropped.
     *
     * All optional: a plate written before this degrades to the previous
     * behaviour rather than replaying flags it never recorded.
     */
    role?: string | null;
    /** #1576 — `--consumer` as passed at launch (crew id, or an explicit override). */
    consumer?: string | null;
    /** #1576 — `--project` as passed at launch. */
    project?: string | null;
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
// #991 — VOLATILE per-session env. Seeded from the invoking shell's `CL_*`
// at each cold `start` (truncated+rewritten), sourced AFTER `env` so it wins,
// and PRESERVED across `reload` (timer respawn). This is where shell-prefix
// overrides (`CL_CAPTURE=1 claude-loop start`) land — so they apply to the
// session without persisting into `env` forever (that footgun is #689). The
// deliberate-persistent channel stays `reload --set` → `env`.
export function envLocalPath(sd: string): string { return join(sd, "env.local"); }
/** #749 david — `claude-loop --zen` / `claude-loop zen <name>` kill switch :
 *  presence of this file mutes ALL wake injections for the loop. Read at the
 *  top of `tryWake`. Persists across restarts (file-based) so a `claude-loop
 *  reload` doesn't reset the user's "leave me alone" intent. */
export function zenPath(sd: string): string { return join(sd, "zen"); }
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
 *  #840 `4z59jt` — les markers sont IPC seul ; les helpers `*Path` ont
 *  été retirés. Reste `resumeSessionPickerActive` / `resumeModePickerActive`
 *  / `bootComplete` sur ipcState. */

/** #647 Slice 2 david `sr9kqw` : setters explicites pour chaque picker
 *  resume distinct (vs l'ancien `setResumePicker` qui ne disait pas
 *  lequel). session-start-hook appelle :
 *    - `setResumeSessionPicker(sd, true)`  au match du 1er écran
 *    - `setResumeModePicker(sd, true)`     au match du 2e écran
 *    - `clearResumePickers(sd)`            après dismiss des deux
 *
 *  bootComplete reste séparé (sealing via le BootMachine acteur — cf.
 *  boot-machine.ts, #872 Phase 3).
 *
 *  #840 `4z59jt` — IPC seul. Plus de marker fichier.
 */

export function setResumeSessionPicker(_sd: string, active: boolean): void {
    setIpcResumeSessionPicker(active);
}

export function setResumeModePicker(_sd: string, active: boolean): void {
    setIpcResumeModePicker(active);
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

const BAR_PAINT_LOG_ENABLED = process.env[CL_ENV.BAR_PAINT_LOG] === "1";
const BAR_PAINT_LOG_T0 = Date.now();

export function logBarPaint(sd: string | undefined, writer: string, value: string): void {
    if (!BAR_PAINT_LOG_ENABLED || !sd) return;
    try {
        const tMs = Date.now() - BAR_PAINT_LOG_T0;
        appendFileSync(barPaintLogPath(sd), `[bar-paint] T+${tMs}ms ${writer} @cl_human=${value}\n`);
    } catch { /* best-effort */ }
}

// #678 david `64j23n`/`242wh7` — debug dump of every `tmux capture-pane`
// frame, opt-in via `CL_PANE_CAPTURE_LOG=1`. One file per capture under
// `<state_dir>/pane-captures/<ISO>.txt` (`:` → `-` for filesystem-safety),
// content = raw pane text. Consecutive dedup : if a new capture is
// identical to the previously written one, skip — a gap in the sorted
// listing means the pane didn't change. Goal : trace retrospectively
// what `capture-pane` actually sees during a /compact so we can update
// the `classifyPaneSpecial` regex/live-signal once and for all.
// #969 — rotation à chaque write. ISO format `YYYY-MM-DDTHH-MM-SS.<ms>Z`
// est string-orderable donc compare-direct sur le nom, pas de stat.
// #1588 — la rotation est passée du TEMPS au NOMBRE de frames, et le cache
// est devenu un réglage de projet (`claude_loop.pane_cache_frames`) au lieu
// d'un opt-in par variable d'env. Motif : le corpus sert à régler les
// détecteurs qui lisent le pane, donc le projet qui fait ce travail le veut
// en permanence pendant que tous les autres n'en veulent pas du tout. Une
// fenêtre en minutes gardait des quantités de preuve très différentes selon
// que la loop bossait ou dormait ; « les N derniers écrans » est ce que veut
// quelqu'un qui lit le corpus.
export function paneCaptureDir(sd: string): string { return join(sd, "pane-captures"); }

// #990 — unified capture dir. `CL_CAPTURE=1` records a replayable session :
// each writer-process appends its own NDJSON timeline here (timer →
// `panes.ndjson`, proxy → `proxy.ndjson`), all stamped with an epoch-seconds
// `t` so the streams merge into one timeline at replay. One file per process
// (not one shared file) keeps O_APPEND atomic between the two processes.
// Pane frames are NOT inlined : each frame is dumped as `panes/<ms>.txt` and
// the timeline row references it by short path (`file`), keeping the NDJSON
// rows small/atomic and the panes greppable as plain files. Append-only : a
// capture is scoped to the session you want to record (vs the rotated legacy).
export function captureDir(sd: string): string { return join(sd, "capture"); }
export function paneTimelinePath(sd: string): string { return join(captureDir(sd), "panes.ndjson"); }
export function capturePanesDir(sd: string): string { return join(captureDir(sd), "panes"); }

const CAPTURE_ENABLED = process.env[CL_ENV.CAPTURE] === "1";

/** Frames kept when the cache is switched on by the env flag alone (i.e. the
 *  project has no `pane_cache_frames`). Same number as the config default a
 *  project would write, so the two ways in behave alike. */
const PANE_CACHE_ENV_DEFAULT = 1000;

let PANE_CACHE_FRAMES: number | null = null;
/** How many pane frames to keep, `0` = cache off.
 *
 *  `CL_PANE_CAPTURE_FRAMES` > `claude_loop.pane_cache_frames` > off, with
 *  `CL_PANE_CAPTURE_LOG=1` kept as the historical on-switch (it now means
 *  "on, at the default size"). Memoised: this is read on every capture tick
 *  and the timer re-execs on `claude-loop reload`, so a stale value can't
 *  outlive the config change that caused it. */
function paneCacheFrames(): number {
    if (PANE_CACHE_FRAMES !== null) return PANE_CACHE_FRAMES;
    const envRaw = process.env[CL_ENV.PANE_CAPTURE_FRAMES];
    const envN = envRaw === undefined ? NaN : Number(envRaw);
    if (Number.isFinite(envN) && envN >= 0) {
        PANE_CACHE_FRAMES = Math.floor(envN);
        return PANE_CACHE_FRAMES;
    }
    let fromCfg = 0;
    try {
        fromCfg = loadConfig(projectCwd()).claude_loop.pane_cache_frames;
    } catch { /* no config reachable → cache stays off */ }
    if (!fromCfg && process.env[CL_ENV.PANE_CAPTURE_LOG] === "1") {
        fromCfg = PANE_CACHE_ENV_DEFAULT;
    }
    PANE_CACHE_FRAMES = fromCfg > 0 ? fromCfg : 0;
    return PANE_CACHE_FRAMES;
}

let lastPaneCaptureWritten: string | null = null; // rotating sink: text-only dedup
// #993 unified-capture dedup : (text + cursor). A cursor-only move IS a new
// frame (it's what tells real input from a ghost suggestion). `lastCaptureText`
// + `lastPaneFile` let a cursor-only move reuse the previous .txt (no dup file).
let lastCaptureKey: string | null = null;
let lastCaptureText: string | null = null;
let lastPaneFile: string | null = null;
let captureSeq = 0; // tie-breaker so two frames in the same ms don't collide

/**
 * Keep the newest `keepFrames` captures, drop the rest. Names are ISO stamps
 * with `:` → `-`, which stay lexicographically ordered, so sorting the names
 * orders them by time without a single `stat`.
 *
 * `keepFrames <= 0` clears the directory: it is the shape of "the cache was
 * turned off", and leaving the old frames behind would be a corpus nobody is
 * maintaining any more.
 */
export function prunePaneCaptures(dir: string, keepFrames: number): void {
    try {
        const frames = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
        const doomed = keepFrames > 0 ? frames.slice(0, Math.max(0, frames.length - keepFrames)) : frames;
        for (const f of doomed) {
            try { unlinkSync(join(dir, f)); } catch { /* skip */ }
        }
    } catch { /* dir gone */ }
}

export function logPaneCapture(sd: string | undefined, text: string, cursor?: { x: number; y: number } | null): void {
    if (!sd) return;
    if (paneCacheFrames() <= 0 && !CAPTURE_ENABLED) return;
    const nowMs = Date.now();
    // #990/#993 unified capture — write a timeline row when the text OR the
    // cursor changed. The frame is dumped as `panes/<ms>.txt` and the row
    // references it by short path (david `684qhp`) + records the cursor
    // (cursorX/cursorY) so a replay can tell real input from a ghost
    // suggestion. A cursor-only move reuses the previous .txt (no dup file).
    if (CAPTURE_ENABLED) {
        const key = `${text}\0${cursor ? `${cursor.x},${cursor.y}` : ""}`;
        if (key !== lastCaptureKey) {
            try {
                let rel = lastPaneFile;
                if (text !== lastCaptureText || !rel) {
                    mkdirSync(capturePanesDir(sd), { recursive: true });
                    rel = join("panes", `${nowMs}-${captureSeq++}.txt`);
                    writeFileSync(join(captureDir(sd), rel), text);
                    lastCaptureText = text;
                    lastPaneFile = rel;
                }
                const rec: Record<string, unknown> = { t: nowMs / 1000, kind: "pane", file: rel };
                if (cursor) { rec.cursorX = cursor.x; rec.cursorY = cursor.y; }
                appendFileSync(paneTimelinePath(sd), JSON.stringify(rec) + "\n");
                lastCaptureKey = key;
            } catch { /* best-effort */ }
        }
    }
    // #678/#969/#1588 — the rotating per-file cache. Distinct from the unified
    // capture above, which is append-only and scoped to a repro you chose to
    // record ; this one runs in the background and keeps a bounded window, so
    // there is always a recent corpus to check the pane detectors against
    // without having known in advance that you would need it.
    //
    // The dedup is the whole reason a permanent cache is affordable: only a
    // frame that DIFFERS from the previous one is written, so an idle loop
    // costs nothing and `frames` counts distinct screens rather than ticks.
    const keep = paneCacheFrames();
    if (keep > 0 && text !== lastPaneCaptureWritten) {
        try {
            const dir = paneCaptureDir(sd);
            mkdirSync(dir, { recursive: true });
            const iso = new Date(nowMs).toISOString().replace(/:/g, "-");
            writeFileSync(join(dir, `${iso}.txt`), text);
            prunePaneCaptures(dir, keep);
            lastPaneCaptureWritten = text;
        } catch { /* best-effort */ }
    }
}

// #733 V2 — pane signals are timer-only and now live exclusively in
// `ipcState`. The legacy filesystem markers (`pane-busy`, `pane-ready`,
// `pane-compacting`, `pane-resuming`, `pane-interrupted`) are gone : no
// writer, no reader, no shadow. Cross-process diagnostics (cli inspect)
// drop those fields entirely. The `sd` parameter stays on every setter
// for callsite-shape stability — it's unused.
//
// Persistence across a timer reload is out of scope here (see #771 —
// micro-db option study).
/** Pane probe: claude pane shows `esc to interrupt` in its footer. */
export function setPaneBusy(_sd: string, busy: boolean): void {
    setIpcPaneBusy(busy);
}
/** Pane probe: prompt signature (`Claude Code v`, `❯ `, …) visible. */
export function setPaneReady(_sd: string, ready: boolean): void {
    setIpcPaneReady(ready);
}
/** Pane probe: `/compact` (manual or auto) in flight — wake gate skips. */
export function setCompacting(_sd: string, compacting: boolean): void {
    setIpcPaneCompacting(compacting);
}
/** Pane probe: "Resuming conversation…" — post-picker, pre-prompt. */
export function setResuming(_sd: string, resuming: boolean): void {
    setIpcPaneResuming(resuming);
}
/** Pane probe: "interrupted by user" — decoration only, not a wake gate. */
export function setInterrupted(_sd: string, interrupted: boolean): void {
    setIpcPaneInterrupted(interrupted);
}
export function pingsPath(sd: string): string { return join(sd, "pings.yaml"); }
// #793 — `idleMarkerPath` removed. The idle-since signal lives in the
// LoopStateBus (set via UDS events from Stop/SessionStart/UserPromptSubmit
// hooks + seeded by the boot pane probe). Callers that need the
// timestamp read `readIdleSinceMs(sd)`; CLI inspection queries the
// timer's loop-server, no file to stat anymore.
/**
 * #793 — single source of truth for "is claude at the prompt"
 * (idle-since timestamp). Pure in-memory now: the bus value, set by
 * the HookService subscribers (Stop / SessionStart / UserPromptSubmit)
 * and seeded at timer boot by a pane probe (`refreshPaneMarkers` →
 * `setIpcIdleSince(now)` if at-prompt). `null` = no signal yet OR
 * explicit clear (UserPromptSubmit fired). The legacy `idle-since`
 * file is gone — david's directive on #793 was "pas de fallback rien
 * du tout vire moi tous ces markers".
 */
export function readIdleSinceMs(_sd: string): number | null {
    const ipc = getIpcState();
    if (ipc.idleSinceCleared) return null;
    return ipc.idleSinceMs;
}
// #840 `4z59jt` — TOUS les markers fichiers (afk / human-typing /
// boot-complete / busy-defer-until / wake-in-flight / last-wake-at /
// wake-requested / resume-{session,mode}-picker-active) sont retirés.
// L'état vit dans ipcState ; le proxy reçoit le push WS du timer ; les
// hook subprocesses primement via `queryLoopState` (UDS round-trip).
/** #730 — single per-loop IPC socket. Carries every direction of the
 *  proxy ↔ timer ↔ hooks IPC: view broadcasts (`{kind:"view"}`),
 *  proxy → timer events (`{kind:"proxyEvent"}`), and wake injects
 *  (`{kind:"inject"}`). Timer is the SERVER (per #729 inversion) ;
 *  proxy + hooks are clients. Previously three sockets per loop
 *  (`view-push.sock` + `proxy-events.sock` + `inject.sock`). */
export function loopSockPath(sd: string): string { return join(sd, "loop.sock"); }
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
// #966 — `timer.pid` / `timer.log` renamed to `loop.pid` / `loop.log` to
// match the file rename (timer.ts → loop.ts). Boot-time migration of
// live state-dirs lives in `loop.ts` top-level (mv if old exists and new
// doesn't).
export function loopPidPath(sd: string): string { return join(sd, "loop.pid"); }
/**
 * Roll-call of every kernel that has ever booted for this loop (#1601).
 *
 * `loop.pid` names the CURRENT kernel, which is all a `kill -HUP` needs. It is
 * not enough to clean up: a reload kills that one pid, so a kernel orphaned by
 * an EARLIER reload is never reaped. On Linux `sweepOrphans` catches those by
 * scanning `/proc/<pid>/environ` for `CL_STATE_DIR`; Windows has no equivalent
 * — a process cannot read another's environment — so the sweep was a silent
 * no-op there and orphans accumulated. Observed live: three kernels for one
 * loop, all alive, all painting the bar with their own AFK countdown (hence a
 * flickering timer) and all connecting to the proxy (hence a link that looked
 * like it was flapping).
 *
 * So the loop keeps its own roll-call instead of asking the OS. Append-only,
 * one pid per line; the sweep reads it, kills what is still alive and is not
 * the caller, and rewrites it.
 */
export function kernelPidsPath(sd: string): string { return join(sd, "kernels.pids"); }

/**
 * Identity of the current boot of the MACHINE, in whole seconds.
 *
 * `Date.now() - uptime` is the instant this machine came up, so it is the same
 * value for every process in this boot and a different one after a restart.
 * It drifts by a second or two as the clock is adjusted, hence the tolerance
 * at the comparison rather than an equality test.
 */
export function bootEpochSec(): number {
    return Math.round(Date.now() / 1000 - osUptime());
}
/** Two stamps belong to the same boot. The window absorbs clock adjustment,
 *  and is far below any plausible interval between two machine boots. */
const BOOT_EPOCH_TOLERANCE_SEC = 30;

/**
 * Add `pid` to the roll-call, STAMPED with this machine's boot.
 *
 * The stamp is what makes the roll-call safe to act on. `process.kill(pid, 0)`
 * answers "a process with this number exists" — never "it is one of ours" — and
 * the file outlives the processes it names: nothing rewrites it when the machine
 * goes down. So after a reboot it holds a pid the OS has since handed to
 * somebody else, and the next kernel to boot would SIGKILL a stranger. Windows
 * recycles pids aggressively; Linux restarts its counter low, so a four-digit
 * pid is reassigned within seconds of coming up.
 *
 * With the stamp, an entry from a previous boot is simply not ours to touch.
 *
 * Best-effort: a lost line costs a missed sweep, never a crash, so this must not
 * throw into the boot path.
 */
export function registerKernelPid(sd: string, pid: number = process.pid): void {
    try { appendFileSync(kernelPidsPath(sd), `${pid} ${bootEpochSec()}\n`); }
    catch { /* best effort */ }
}

/**
 * Claim the loop: register, then kill every OTHER kernel still holding it.
 *
 * A sweep driven by the CLI runs before it spawns, so it cannot see a kernel
 * that appears afterwards — and one does, routinely: changing the source makes
 * the running kernel self-reload, and a `claude-loop reload` issued around the
 * same moment adds a second. Measured after exactly that sequence: two live
 * kernels per loop, both registered, neither swept, both painting the bar.
 *
 * Doing it at boot instead is self-healing whatever spawned us, and the rule it
 * enforces is the real invariant: one kernel per loop, and the newest wins —
 * it holds the freshest source and the freshest state.
 */
export function claimLoopAsKernel(sd: string): { killed: number[] } {
    registerKernelPid(sd);
    const killed: number[] = [];
    const survivors: number[] = [process.pid];
    for (const pid of readKernelPids(sd)) {
        if (pid === process.pid) continue;
        try { process.kill(pid, 0); } catch { continue; } // already gone
        try { process.kill(pid, "SIGKILL"); killed.push(pid); }
        catch { survivors.push(pid); /* race, or not ours */ }
    }
    writeKernelPids(sd, survivors);
    return { killed };
}

/**
 * Pids registered during THIS boot of the machine, de-duplicated, most recent
 * last. Callers SIGKILL what this returns, so everything it cannot vouch for is
 * left out:
 *
 *  - an entry from another boot — its pid now belongs to whatever the OS gave
 *    the number to since;
 *  - an entry with no stamp — written before this file carried one, so it says
 *    nothing about which boot it came from.
 *
 * Dropping both loses at worst an orphan kernel, which costs a flickering bar
 * until the next reload. Keeping them risks killing a process that has nothing
 * to do with aiball, silently, at loop start. Those are not comparable.
 */
export function readKernelPids(sd: string): number[] {
    const now = bootEpochSec();
    try {
        const seen = new Set<number>();
        for (const line of readFileSync(kernelPidsPath(sd), "utf8").split("\n")) {
            const [rawPid, rawEpoch] = line.trim().split(/\s+/);
            const pid = Number(rawPid);
            const epoch = Number(rawEpoch);
            if (!Number.isInteger(pid) || pid <= 0) continue;
            if (!Number.isFinite(epoch)) continue; // unstamped legacy line
            if (Math.abs(epoch - now) > BOOT_EPOCH_TOLERANCE_SEC) continue; // another boot
            seen.add(pid);
        }
        return [...seen];
    } catch { return []; }
}

/** Rewrite the roll-call to exactly `pids` (used after a sweep), re-stamping
 *  them with the current boot — they are all live processes of it. */
export function writeKernelPids(sd: string, pids: number[]): void {
    const stamp = bootEpochSec();
    try { writeFileSync(kernelPidsPath(sd), pids.map((p) => `${p} ${stamp}\n`).join("")); }
    catch { /* best effort */ }
}
export function loopLogPath(sd: string): string { return join(sd, "loop.log"); }
/**
 * Touched by the timer / stop-hook RIGHT BEFORE they `send-keys` an
 * auto-wake into the claude pane. The UserPromptSubmit hook checks
 * this marker on fire: if present + mtime < ~2s, the prompt came from
 * claude-loop itself (auto-wake, not a human submission) → the hook
 * propagates `from_auto_wake=true` so the timer doesn't flip its
 * in-memory `idleSinceMs` to null. Marker then deleted by the hook.
 */
// #840 — `wakeInFlightPath` retiré, IPC seul (`ipc.wakeInFlightAtMs`).
/** Wake-in-flight markers older than this many ms are stale and
 *  ignored — covers race where the user types BEFORE claude-loop's
 *  wake reaches the hook (unlikely but possible). #B.180:
 *  yaml-configurable via `.aiball.yaml claude_loop.wake_in_flight_ttl_ms`. */
export const WAKE_IN_FLIGHT_TTL_MS = Math.max(0, loopConfig().claude_loop.wake_in_flight_ttl_ms);

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
// #840 — `lastWakeAtPath` retiré, IPC seul (`ipc.lastWakeAtMs`).

/** Wake-coalesce window — minimum spacing between two wake injections.
 *  Anti-burst only: each FIFO event is a discrete wake, but a string of
 *  triggers landing inside this window collapses to one fire. Default 10s
 *  (bumped from 5s in #807 c8dxpm — stop-hook + afkCleared transitions can
 *  telescope past a tighter window). Covers SSE bursts, AFK-clear-drain,
 *  stop-hook chain, heartbeat ticks that fire back-to-back. Env-tunable
 *  via CL_WAKE_COALESCE_WINDOW_MS. */
export const WAKE_COALESCE_WINDOW_MS = Math.max(0, Number(process.env[CL_ENV.WAKE_COALESCE_WINDOW_MS] ?? 10000));

/**
 * Pure dedup decision. SKIP if any wake was injected less than `windowMs`
 * ago (anti-burst: collapses a fast string of triggers to one fire);
 * otherwise return the new marker to persist. `windowMs <= 0` disables.
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
 * #379 / #813 — set-aware dedup watermark for the actionable wake leg.
 * The legacy count watermark (`last-open-wake-count` + `recordOpenWakeCount`
 * + `readLastOpenWakeCount`) was retired in #814 (spinoff of #813) : the
 * landscape hash is the sole survivor and its only remaining job is the
 * fin-de-ligne cultural-wake suppression in `timer.ts:tryWake` (#813
 * `2nnuq6`). The count missed SWAPS (a ticket leaves my court while another
 * enters → count constant → no re-wake → the new actionable ticket never
 * surfaced) ; the hash changes on any set churn, so the same N idle tickets
 * stay deduped but a genuine change re-wakes.
 *
 * V4 Phase 1 — `last-open-wake-hash`, `drained-state`, `last-wake-hint`
 * are pure timer-only state (no cross-process writers) and live in the
 * in-memory `IpcState` instead of marker files. The `sd` parameter is
 * kept on each helper for API stability but ignored. Restart-loss is
 * the documented trade-off : a fresh timer respawn resets the watermarks,
 * which can let one stale wake fire ; cheap vs the marker complexity it
 * replaces.
 */

/** Read the last landscape hash we woke on; "" when missing (→ first wake). */
export function readLastOpenWakeHash(_sd: string): string {
    return getIpcState().lastOpenWakeHash ?? "";
}

/** Persist the landscape hash after a successful wake. */
export function recordOpenWakeHash(_sd: string, hash: string): void {
    setIpcLastOpenWakeHash(hash);
}

/** Read the drained-strategy state, or null when fresh / restart. */
export function readDrainedState(_sd: string): DrainedState | null {
    return getIpcState().drainedState;
}

/** Persist the drained-strategy state in-memory. */
export function writeDrainedState(_sd: string, value: DrainedState): void {
    setIpcDrainedState(value);
}

/** Persist the hint that just triggered a wake. Pass `undefined` to
 *  no-op (we only want hinted wakes in the dedup ledger; un-hinted
 *  pop-culture wakes coalesce via `lastWakeAtPath` already). */
export function recordWakeHint(_sd: string, hint: WakeHint | undefined): void {
    if (!hint || hint.ticket_id === undefined) return;
    setIpcLastWakeHint({
        ticket_id: hint.ticket_id,
        comment_hashid: hint.comment_hashid,
        at_ms: Date.now(),
    });
}

/** True iff `hint` matches the last recorded wake hint AND it was
 *  recorded within `windowMs`. Use to drop duplicate SSE pings before
 *  invoking the wake path. Fail-open : no recorded hint / no ticket
 *  id → false (let the wake fire). */
export function isDuplicateWakeHint(_sd: string, hint: WakeHint | undefined, windowMs: number): boolean {
    if (!hint || hint.ticket_id === undefined) return false;
    const prev = getIpcState().lastWakeHint;
    if (!prev) return false;
    if (Date.now() - prev.at_ms > windowMs) return false;
    return prev.ticket_id === hint.ticket_id
        && (prev.comment_hashid ?? null) === (hint.comment_hashid ?? null);
}

/** #B.198 — defer (not gate) the next wake when the Stop-hook fire-time
 *  pane still shows `esc to interrupt`. The footer may be stale (#B.185)
 *  so a hard skip would lose wakes; the marker-based defer survives the
 *  hook process exiting. */
export const PANE_BUSY_DELAY_MS = Math.max(0, Number(process.env[CL_ENV.PANE_BUSY_DELAY_MS] ?? 5000));

// #840 `4z59jt` — `busyDeferUntilPath` retiré. Le gate vit dans
// `ipc.busyDeferUntilMs` ; les hook subprocesses primement via UDS
// (queryLoopState).

/** Arm the defer gate so the next wake is blocked until `now + ms`.
 *  Idempotent : pushes the existing gate forward if the new target is
 *  later, never shortens an existing defer (a fresh busy snapshot
 *  mid-defer extends the wait, doesn't cut it).
 *  #840 `4z59jt` — IPC seul. `setIpcBusyDeferUntil` est l'unique write
 *  (lu par `readBusyDefer` + diffusé aux hook subprocesses via le UDS
 *  `queryLoopState`). */
export function armBusyDefer(_sd: string, ms: number): string {
    if (ms <= 0) return "";
    const target = Date.now() + ms;
    const prev = getIpcState().busyDeferUntilMs;
    if (prev !== null && prev > target) {
        return new Date(prev).toISOString();
    }
    setIpcBusyDeferUntil(target);
    return new Date(target).toISOString();
}

/** #840 Slice B — snapshot des champs `ipcState` que le timer renvoie
 *  via `loop.sock` à un hook/CLI subprocess qui demande l'état live.
 *  Mirror `IpcState` pour les champs effectivement consommés ; doublé
 *  côté `hook-verdict.queryLoopState` et `cmds/inspect`. #972 — extraction
 *  dans state.ts pour dedup type + bloc de 10 setIpc.
 */
export interface LiveLoopSnapshot {
    paneBusy: boolean;
    paneReady: boolean;
    paneCompacting: boolean;
    paneResuming: boolean;
    paneInterrupted: boolean;
    afkMode: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs: number | null;
    humanTypingAtMs: number | null;
    idleSinceMs: number | null;
    bootComplete: boolean | null;
    bootActiveModules?: string[];
    busyDeferUntilMs: number | null;
}

/** #972 — applique un `LiveLoopSnapshot` reçu via UDS sur l'ipcState
 *  local du subprocess, pour que `readLoopStateInput` retourne les valeurs
 *  live. Idiome doublé pre-#972 dans `hook-verdict.queryLoopState` et
 *  `cmds/inspect.cmdInspect` ; centralisé ici. */
export function mirrorLiveSnapshotToIpc(live: LiveLoopSnapshot): void {
    setIpcPaneBusy(live.paneBusy);
    setIpcPaneReady(live.paneReady);
    setIpcPaneCompacting(live.paneCompacting);
    setIpcPaneResuming(live.paneResuming);
    setIpcPaneInterrupted(live.paneInterrupted);
    setIpcAfk(live.afkMode, live.afkExpiryMs);
    setIpcHumanTypingAtMs(live.humanTypingAtMs);
    setIpcIdleSince(live.idleSinceMs);
    if (live.bootComplete !== null) setIpcBootComplete(live.bootComplete);
    if (live.bootActiveModules) setIpcBootActiveModules(live.bootActiveModules);
    setIpcBusyDeferUntil(live.busyDeferUntilMs);
}

/** Read the defer marker. Returns `{ activeMs }` with the remaining
 *  defer window in ms, or `null` if the gate is open (no marker, parse
 *  failure, or target already past).
 *  #840 (david `n2xbe9` "zero file fallback") — ipc-only read. Hooks
 *  prime ipcState via `queryLoopState` (UDS) before calling ; a dead
 *  timer leaves ipcState empty → returns null → fail-open by the
 *  safe default, not by re-reading a file shadow. `sd` is kept in the
 *  signature for source compatibility but unused. */
export function readBusyDefer(_sd: string): { activeMs: number; until: Date } | null {
    const ms = getIpcState().busyDeferUntilMs;
    if (ms === null) return null;
    const activeMs = ms - Date.now();
    if (!Number.isFinite(activeMs) || activeMs <= 0) return null;
    return { activeMs, until: new Date(ms) };
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
    _sd?: string | null,
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
            // #813 qzrj42 — drop the #379 landscape-hash watermark and the
            // legacy count watermark. The backlog cooldown #786 (per-consumer,
            // per-ticket, 1h) already handles the "don't re-wake the same
            // ticket forever" concern : each wake on a backlog ticket arms
            // the cooldown, the next heartbeat picks the next non-cooled
            // ticket, and after all are cooled the loop goes silent until
            // the 1h window expires and a ticket re-surfaces. The watermark
            // was BLOCKING that rotation (`landscapeHash === seen` →
            // has:false even with 24 actionable tickets ready to fire) ; the
            // cooldown gives us the same "no spam" property without the
            // false-negative on a stable landscape. `sd` arg + landscapeHash
            // field kept for back-compat ; readLastOpenWakeHash /
            // readLastOpenWakeCount become dead-code candidates (separate
            // cleanup).
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

/** #351 + #619 david `f97nu6` — true iff a NOT-AFK hold is active, i.e. the
 *  human declared **PRESENT** (held the loop). #977 — renamed from the
 *  misleading `afkActive` : the value is `human present`, NOT `human away`.
 *  `afkMode` 3-state cycle via the F9 key :
 *    `off`        → autonomous / human AWAY  → returns **false**
 *    `wait_inf`   → NOT-AFK ∞ (held present)  → returns **true**
 *    `wait_10m`   → NOT-AFK until expiry      → true while `expiry > now`
 *  So `present = humanPresentHold()` ; an away/autonomous loop is `off`. */
export function humanPresentHold(_sd: string): boolean {
    // #840 (david `n2xbe9` "zero file fallback") — ipc-only.
    const ipc = getIpcState();
    if (ipc.afkMode === "wait_inf") return true;
    if (ipc.afkMode === "wait_10m" && ipc.afkExpiryMs !== null) {
        return ipc.afkExpiryMs > Date.now();
    }
    return false;
}

/** #624 david `e3a6nn` : arm a NOT AFK 10m hold from the TS side
 *  (settleBoot's `--wait` path). #840 `4z59jt` — IPC seul. */
export function armAfk10m(_sd: string, seconds: number = loopConfig().claude_loop.presence_hold_seconds): void {
    const expiry = Date.now() + seconds * 1000;
    setIpcAfk("wait_10m", expiry);
}

/** #633 Slice C — NOT AFK ∞ hold (released only by F9). IPC seul. */
export function setAfkInfinite(_sd: string): void {
    setIpcAfk("wait_inf", null);
}

/** #633 Slice C — return to AFK (autonomous loop, no hold). IPC seul. */
export function clearAfk(_sd: string): void {
    setIpcAfk("off", null);
}

/** #633 Slice D — touch the `human-typing` IPC stamp. #880 — délégué au
 *  TypingController acteur ; `setIpcHumanTypingAtMs` est appelé par le
 *  subscriber bridge dans timer.ts. Le bar word "stop" et la chip typing
 *  lisent toujours `ipc.humanTypingAtMs` via le bus (= back-compat). */
export function touchHumanTyping(_sd: string): void {
    getTypingService().keystroke();
}

/** #633 Slice C — F9 toggle implemented on the TS side. Reads the
 *  current AFK mode and cycles to the next : off → wait_10m → wait_inf
 *  → off. The ∞ → off branch also clears user-grace (atomic release
 *  of both holds — matches the proxy's `toggle_afk`). */
/** #751 htwguc — debounce window before a F9 toggle commits to `afk`.
 *  Fast multi-press cycles `dispAfk` visually but the SM only sees
 *  the final intent after the window settles. */
export const AFK_DEBOUNCE_MS = 3000;

export function toggleAfk(sd: string, _seconds = 600): void {
    void _seconds; // legacy arg kept for signature back-compat
    void sd;       // sd not needed — actor owns the AFK lifecycle
    // F9 cycle : read the AfkController actor snapshot to determine the
    // currently displayed mode (= committed mode if no pending, else the
    // pending target). Compute the next kind and send the matching ARM_X
    // debounced event ; the actor's `after(debounce)` commits it. NOOP
    // same-kind is encoded in the machine via the `committedIsWait10m`
    // guard on the `pending_10m → wait_10m` transition.
    const svc = getAfkService();
    const snap = svc.getActor().getSnapshot();
    const v = String(snap.value);
    const curDispMode: "off" | "wait_10m" | "wait_inf" =
        v === "off" || v === "pending_off" ? "off"
        : v === "wait_10m" || v === "pending_10m" ? "wait_10m"
        : "wait_inf";
    let nextMode: "off" | "wait_10m" | "wait_inf";
    if (curDispMode === "off") nextMode = "wait_10m";
    else if (curDispMode === "wait_10m") nextMode = "wait_inf";
    else nextMode = "off";
    if (nextMode === "wait_10m") {
        // Mirror the committed expiry if cycle returns to wait_10m
        // (= the running timer continues on its course post-NOOP) ;
        // otherwise hint the fresh 10min expiry.
        const ctx = snap.context;
        const expiryMsHint = ctx.afkMode === "wait_10m" && ctx.afkExpiryMs !== null
            ? ctx.afkExpiryMs
            : Date.now() + loopConfig().claude_loop.presence_hold_seconds * 1000;
        svc.arm10m(expiryMsHint);
    } else if (nextMode === "wait_inf") {
        svc.armInf();
    } else {
        svc.armOff();
    }
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
    const cfg = loopConfig().claude_loop;
    const bootGraceMs = Math.max(0, cfg.boot_grace_seconds) * 1000;
    // #629 david `2hwuan` : floor INVIOLABLE 30 s par défaut.
    const bootMinMs = Math.max(0, cfg.boot_min_seconds) * 1000;
    // #647 Slice 2 : resumePickerActive = OR des deux nouveaux markers.
    // Conserve la sémantique "any resume picker is up" pour les consommateurs
    // existants ; la distinction session vs mode est exposable via les
    // chemins dédiés (resumeSessionPickerActivePath / resumeModePickerActivePath)
    // pour les futurs consommateurs (bar slice 4).
    // #727 V1 Slice B — in-memory signal wins when the timer's HookService
    // subscriber has flipped bootComplete via a SessionStart event ; we
    // fall back to the file marker when no signal landed yet (timer
    // freshly restarted, or the hook fell back to file write because the
    // ws emit failed).
    const ipc = getIpcState();
    // #840 `4z59jt` — david "vire tout marker fichier". Plus de gate
    // strict ni de fallback fichier : `readLoopStateInput` est IPC-only.
    // Les hook subprocesses primaient leur ipcState via `queryLoopState`
    // (UDS round-trip vers le timer) avant ce read. UDS down → safe
    // defaults ci-dessous (= AFK off, pas de marker actif, boot grace
    // floor). Pré-#840 les fallbacks `?? safeMtime(...)`/`?? existsSync()`
    // re-lisaient les shadows du timer ; ces shadows n'existent plus.
    const sessionPickerActive = ipc.resumeSessionPickerActive ?? false;
    const modePickerActive = ipc.resumeModePickerActive ?? false;
    const resumePickerActive = sessionPickerActive || modePickerActive;
    const bootComplete = ipc.bootComplete ?? false;
    const noWait = !cfg.wait;
    const wakeInFlightTtlMs = Math.max(0, cfg.wake_in_flight_ttl_ms);
    const inputHotTtlMs = Math.max(0, cfg.input_hot_ttl_ms);

    const afk: { mode: "off" | "wait_10m" | "wait_inf"; expiryMs: number | null } = ipc.afkMode !== null
        ? { mode: ipc.afkMode, expiryMs: ipc.afkExpiryMs }
        : { mode: "off", expiryMs: null };
    return {
        nowMs,
        loopStartMs: startMs,
        bootGraceMs,
        bootMinMs,
        resumePickerActive,
        bootComplete,
        // #733 V2 — pane signals live exclusively in `ipcState`. No file
        // fallback : a subprocess (hook, cli inspect) reading via
        // `readLoopStateInput` gets `false` for every pane field. The hook
        // verdict doesn't depend on pane signals (only `afkHoldActive`) ;
        // cli inspect's pane block now reflects the subprocess view (always
        // false from outside the timer process). #771 covers the future
        // persistence-across-reload option.
        paneBusy: ipc.paneBusy ?? false,
        paneReady: ipc.paneReady ?? false,
        paneCompacting: ipc.paneCompacting ?? false,
        paneInterrupted: ipc.paneInterrupted ?? false,
        notLoggedIn: ipc.notLoggedIn ?? false,
        apiUnreachableSinceMs: ipc.apiUnreachableSinceMs ?? null,
        apiUnreachableSeenMs: ipc.apiUnreachableSeenMs ?? null,
        apiUnreachableTtlMs: API_UNREACHABLE_TTL_MS,
        noWait,
        humanTypingAtMs: ipc.humanTypingAtMs,
        humanTypingTtlMs: HUMAN_TYPING_TTL_SEC * 1000,
        afkMode: afk.mode,
        afkExpiryMs: afk.expiryMs,
        // #751 htwguc — `dispAfk` lit purement ipcState. Aucun fichier
        // marker. Null = pas de toggle pending → renderAfkChunk converge
        // sur `afkMode`. Le commit (timer tick) consomme ce couple via
        // les *ViaService helpers + clear le dispAfk → convergence.
        dispAfkMode: ipc.dispAfkMode,
        dispAfkExpiryMs: ipc.dispAfkExpiryMs,
        dispAfkCommitAtMs: ipc.dispAfkCommitAtMs,
        // #727 V1 Slice B — in-memory truth wins. Shared with the
        // pre-gate paths in timer.ts via `readIdleSinceMs`.
        idleSinceMs: readIdleSinceMs(sd),
        wakeInFlightAtMs: ipc.wakeInFlightAtMs,
        wakeInFlightTtlMs,
        busyDeferUntilMs: ipc.busyDeferUntilMs,
        bootDeadlineMs: ipc.bootDeadlineMs,
        inputHotTtlMs,
        manualWake: opts.manualWake ?? false,
    };
}

/**
 * #264: short TTL for the near-live "human typing" chip. The detection
 * poll refreshes the marker while the human types; once they stop, the
 * chip lingers ~this long then clears. Kept short so the bar tracks
 * typing closely; the AFK SM (typing arms NOT AFK 10m) carries any
 * longer-lived "human present" signal.
 */
export const HUMAN_TYPING_TTL_SEC = 5;

/** #1116 Slice 2 — API-unreachable wake-hold TTL (ms). Past this window the
 *  wake gate fails open so a terminal 10/10 retry failure or a detection
 *  false-positive can never freeze the loop. Env-overridable. */
export const API_UNREACHABLE_TTL_MS =
    Math.max(0, Number(process.env[CL_ENV.API_UNREACHABLE_TTL_MS] ?? 120_000));

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

/** Is a human typing in the pane right now (within the TTL)? (#264)
 *  #840 (david `n2xbe9` "zero file fallback") — ipc-only. */
export function humanIsTyping(_sd: string, ttlSec = HUMAN_TYPING_TTL_SEC): boolean {
    const ts = getIpcState().humanTypingAtMs;
    if (ts === null) return false;
    return (Date.now() - ts) < ttlSec * 1000;
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
    // #685 — `bin/aiball` wrapper chdirs into the install root before
    // exec'ing tsx (so `process.cwd()` returns the dev checkout, not the
    // user's invocation dir). The wrapper preserves the original PWD in
    // `AIBALL_CWD` ; honor it so `claude-loop status` reports the user's
    // actual cwd instead of the misleading install root. Same env that
    // `cli/_helpers.ts:userCwd()` uses, just inlined here to avoid the
    // cli → state import cycle.
    return { cwd: process.env.AIBALL_CWD ?? process.cwd(), source: "cwd" };
}

let PROJECT_CWD_CACHED: string | null = null;
function projectCwd(): string {
    if (PROJECT_CWD_CACHED) return PROJECT_CWD_CACHED;
    PROJECT_CWD_CACHED = projectCwdInfo().cwd;
    return PROJECT_CWD_CACHED;
}

let BAR_COLORS: AiballConfig["colors"] | null = null;
export function barColors(): AiballConfig["colors"] {
    // #480 / #481 : cwd projet via plate.json (source unique) avec
    // override env `AIBALL_PROJECT_CWD` et fallback `process.cwd()`.
    if (!BAR_COLORS) BAR_COLORS = loadConfig(projectCwd()).colors;
    return BAR_COLORS;
}
export const stateBg = (col: AiballConfig["colors"], s: LoopStatus): string =>
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
 *   - `wait` (yellow colour178) — auto-pings FROZEN: the boot-grace window
 *                                 at launch (#305) or an AFK hold (NOT AFK
 *                                 10m / ∞) where the human asked to hold
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
export function humanPresence(sd: string | undefined): "stop" | "wait" | "boot" | "loop" {
    // #627 — delegate to the central LoopState service so the bar word
    // computation matches the one used by every other consumer (timer,
    // proxy mirror, hooks). #745 phase B — the legacy `graceSec` arg
    // is gone ; the AFK SM owns the "wait" path now (NOT AFK 10m / ∞).
    // #853 david : sd-less fallback was `loop` historically ; bascule à
    // `boot` par construction. Cohérent avec le fix proxy `_rest_word` +
    // template fallback (70cd3f4). Couvre le _rest_word bootstrap = BOOT
    if (!sd) return "boot";
    return computeLoopView(readLoopStateInput(sd)).presence;
}

export function humanPresenceChunk(sd: string | undefined): string {
    // david `<chat>` 2026-06-14 : le glyph hot-typing `⌨` est désormais
    // indépendant du wait/loop (typingGlyphChunk ci-dessous), donc cette
    // fonction ne gère plus que les 2 valeurs orthogonales au typing :
    //   - wait → ⏸ orange (AFK armé : wait_10m / wait_inf)
    //   - loop → ▶ vert   (autonomous, AFK off)
    //   - boot → vide     (couvert par le 🚀 dans les markers)
    // Plain text variants (sans U+FE0F) pour respecter le fg color.
    if (!sd) return "";
    const input = readLoopStateInput(sd);
    if (isInBootGrace(input)) return "";
    const afkOn = isHumanPresentHold(input);
    const glyph = afkOn ? "⏸" : "▶";
    const fg = afkOn ? "colour178" : "colour40";
    // david `<chat>` 2026-06-14 : `▶/⏸` migre AVANT le mot `claude`
    // aussi → leading space inclus dans la valeur quand non-vide
    // pour garder le bloc compact.
    return ` #[fg=${fg},bg=colour16]${glyph}`;
}

/** #953 david `<chat>` : `⌨` glyph rouge quand le user tape activement,
 *  rendu indépendamment du wait/loop (donc affiché EN PLUS, pas EN
 *  REMPLACEMENT). Peint dans `@cl_typing` ; placé entre `@cl_prompt` et
 *  `@cl_human` dans le status-left. Empty quand pas de typing récent. */
export function typingGlyphChunk(sd: string | undefined): string {
    if (!sd) return "";
    if (!humanIsTyping(sd)) return "";
    return `#[fg=colour196,bg=colour16]⌨`;
}

/** #962 — pure mapping `AfkChunk` → glyph + tmux color tags. Extrait
 *  pour testabilité ; consommé par `afkGlyphChunk` qui ajoute le I/O. */
export function formatAfkGlyph(chunk: { color: "dim" | "yellow" | "red"; prefix: string | null }): string {
    const fg = chunk.color === "red" ? "colour196"
        : chunk.color === "yellow" ? "colour178"
            : "colour238"; // dim
    const suffix = chunk.prefix ?? "";
    return ` #[fg=${fg},bg=colour16]웃${suffix}`;
}

/** #962 david `<chat>` 2026-06-14 : le statut AFK migre du status-right
 *  (chip texte `AFK:F9` / `NOT AFK ∞:F9` peint dynamiquement) vers un
 *  glyph « bonhomme » `웃` à la fin de la zone claude (status-left).
 *  Couleur + suffix selon le mode de la loop :
 *    - autonomous (AFK label `AFK`, color dim)        → gris foncé, no suffix
 *    - held ∞     (AFK label `NOT AFK`, color red)    → rouge,      suffix `∞`
 *    - held 10m   (AFK label `NOT AFK`, color yellow) → orange,     suffix `Ns` countdown
 *  Glyph plain text (pas de U+FE0F) pour que la fg tmux applique. Peint
 *  dans `@cl_afk_glyph` ; placé après `@cl_state` dans le status-left.
 *  Status-right devient un literal statique `AFK:F9` (dim). */
export function afkGlyphChunk(sd: string | undefined): string {
    if (!sd) return "";
    // david 2026-06-14 : le glyph s'affiche DÈS le boot (pas de gate
    // boot grace). En boot le mode est `off` par défaut → `웃` gris foncé
    // sans suffix ; le contraste avec le bg jaune boot reste lisible.
    return formatAfkGlyph(computeLoopView(readLoopStateInput(sd)).afkChunk);
}

/**
 * #800 9sy4t3 — paint the counters segment of the tmux bar. Sits in its own
 * `@cl_counts` tmux user option so state repaints (transitions, hooks) don't
 * clobber a fresher counter snapshot, and counters survive across every
 * state (idle / boot / busy) as david asked.
 *
 * Layout : ` o:M b:B e:N` (ASCII default, single leading space — the format
 * concatenates straight after `@cl_state`). Zero counters render as `o:0`
 * etc. so the segment is always the same width and the absence is explicit.
 *
 * Pass `null` / `undefined` counters to clear the segment.
 * No-op when tmux is gone (loop was just rm'd) — never throws.
 */
// #862 Slice 5 — `setTmuxCounters` / `setTmuxStatus` retirés.
// Callers ont migré directement vers `setIpcCounters` / `setIpcStateTagInfo`
// (ipc-state.ts). Le BarRenderer (bar-renderer.ts) peint depuis ipcState.

// #962 — `formatAfkStateChunk` / `afkStateChunkStr` retirés. L'AFK
// state ne vit plus en chip texte côté status-right (qui devient
// `AFK:F9` statique) ; le statut dynamique migre dans `afkGlyphChunk`
// (un glyph `웃` coloré à la fin de la zone claude, peint dans
// `@cl_afk_glyph` par BarRenderer).

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
/**
 * True iff the pane shows Claude Code's ACTIVITY line — the spinner row that
 * carries an elapsed timer and/or a token counter, e.g.
 *
 *     ✻ Honking… (1m 7s · ↓ 2.3k tokens)
 *     ⎿  Running… (27s · timeout 4m)
 *
 * #1580 — the busy stack used to rest entirely on `esc to interrupt`, which is
 * an intermittent FOOTER HINT: measured on a live loop, present in 5 of 30
 * captures while claude worked without pause, while this line was there 30/30.
 * Resting a state on a hint that rotates is what let the bar go grey mid-turn.
 *
 * Anchored on the SHAPE, not the words: the gerund is randomised by Claude Code
 * ("Honking", "Smooshing", …) and the spinner glyph cycles — and psmux degrades
 * some of those glyphs anyway (`✻` arrives as `*`). What is stable is the
 * parenthesised elapsed time and the arrowed token counter.
 *
 * Whole-pane scope on purpose: the activity line sits ABOVE the prompt box, so
 * a footer-sized window (5 non-empty lines, two of which are box rules) misses
 * it. It is specific enough not to need the scope.
 */
export function paneShowsActivity(paneText: string): boolean {
    const ELAPSED = /\((?:\d+m\s*)?\d+s\s*·/;
    const TOKENS = /[↓↑]\s*[\d.]+k?\s*tokens/i;
    // The activity line OPENS its row: an optional spinner glyph or tool-result
    // marker, a word, then the parenthesised timer. Anything further in is
    // quoted text, not the live indicator.
    //
    // Whole-pane scope with a match-anywhere rule made the pane quote itself
    // into a busy proof: reading a log, showing a capture, or diffing this very
    // detector puts an activity line in a tool result, which then SITS IN
    // SCROLLBACK after the turn ends. Caught on a live capture — the pane held
    // two matches, one live spinner and one echoed from a command's output:
    //
    //     ⎿  rang -8 | ✻ Coalescing… (54s · ↓ 1.9k tokens)     ← quoted, stale
    //     ✶ Whirring… (1m 52s · ↓ 4.5k tokens)                 ← the real one
    //
    // A stale match re-signals the proof every tick, so the authoritative
    // release never fires again and busy sticks — the #992 failure it exists to
    // prevent, and it silently gates the wake. Same shape as the prompt-line
    // filter `footerOf` needed when a wake phrase quoted an error banner.
    // Structural anchor: indent, an optional spinner glyph or `⎿` marker, ONE
    // ellipsed word, then the parenthesis. The ellipsis is what every captured
    // form carries — `Honking…`, `Smooshing…`, `Running…` — and it is what a
    // quoted line lacks in that position: a rank, a pipe or a function call sits
    // there instead. Without it, `assert.equal(paneShowsActivity("…"), true)`
    // read as activity, which is a test file scrolling past.
    //
    // If Claude Code ever drops the ellipsis this misses a real line — a false
    // NEGATIVE, which only falls back on the `esc` and `turn` proofs. That is
    // the survivable direction; a false positive sticks busy forever.
    const HEAD = /^\s*(?:\S\s+)?(?:⎿\s+)?[^\s(]*…\s*\(/u;
    return paneText.split("\n").some((l) =>
        HEAD.test(l) && (ELAPSED.test(l) || TOKENS.test(l)));
}

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
 * captured pane text. Thin wrapper around the unified module
 * `compacting-detector.ts` (#843) so the Stop hook, the timer, and
 * the autopoll hook all agree. Caller is responsible for the latch:
 * this entry point is PURE/raw. The timer uses the stateful
 * `CompactingDetector` singleton (latch absorbs frame-race flicker).
 *
 * `footerLines` kept as a legacy parameter for older call sites &
 * tests; passed through to the detector's `footerLines` option. Pass
 * an explicit context with `{ isBoot: true }` when the caller knows
 * boot phase is active (widens the footer scope to absorb a slightly
 * different render).
 */
export function classifyPaneSpecial(
    text: string,
    footerLines = 12,
    ctx: { isBoot?: boolean } = {},
): PaneSpecial | null {
    return classifyCompactingRaw(text, ctx, { footerLines, bootFooterLines: footerLines + 6 })
        ? "compacting"
        : null;
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
export interface ContextPhraseResult {
    phrase: string;
    /** The message_id of the unread FIFO head that fed the phrase, when
     *  one exists. The wake injection site marks it seen the moment the
     *  inject crosses the gate (a delivered wake = the agent has read
     *  the event). Null for backlog-head wakes and for idle / no-head
     *  culture pings. */
    headMessageId: number | null;
    /** #1163 S2 — ids des decision-events groupés dans le digest (au-delà du
     *  head) : à marquer seen au même moment que le head à l'injection. */
    extraSeenIds?: number[];
    /** True iff the phrase carries actionable content (FIFO head,
     *  ticket_created head, lifecycle head, or backlog head). False
     *  when the phrase is just the idle culture+lead. Drain-style
     *  callers (afk-cleared-drain, boot-ended-drain) skip on false so
     *  claude isn't woken to read "Houston, we have an idle session". */
    hasContent: boolean;
    /** #786 — id of the BACKLOG-branch ticket head, when the backlog
     *  branch fired. Used by the inject site to call recordBacklogWake
     *  so the per-consumer cooldown clock starts. Null when the wake
     *  fired a FIFO event, a lifecycle event, or the idle phrase. */
    backlogTicketId: number | null;
    /** #1554 — the ticket this event-wake concerns (head ticket of a same-ticket
     *  bundle). Null for backlog / idle. Surfaced so wake:diag can log the
     *  ticket a delivered wake is about. */
    wakeTicketId?: number | null;
    /** #1554 — number of DISTINCT tickets in the delivered bundle. Same-ticket by
     *  construction (=1); a value >1 would flag the "multiple tickets in one
     *  wake" bug (#1554). 0 when there's no head (idle). */
    bundleTicketCount?: number;
}

/**
 * #999 — the resolved EVENT that triggered this wake (SSE ping → a concrete
 * comment / artifact). Present iff the wake came from an event, absent on the
 * heartbeat / drain re-check paths. The format is routed by this discriminator:
 * an event wake renders the COMMENT-centric branch (body + ref) anchored on the
 * hint, and NEVER the backlog ticket-centric "look #N… Triage" branch — that
 * one is reserved for the no-hint heartbeat path (FIFO empty → backlog tiers).
 */
export interface WakeEventHint {
    ticketId: number;
    /** #1569 — id of the triggering message. Needed when the wake anchors on
     *  the hint instead of the FIFO head: whatever we RENDER is what the inject
     *  site must mark seen, otherwise we ack an event we never showed. */
    commentId?: number;
    /** comment hashid of the triggering comment_added, when the event is a
     *  comment. Drives the comment-centric anchor. */
    commentHashid?: string;
    /** markdown-stripped comment body (already truncated upstream). */
    commentBody?: string;
    /** #1169 — kind of the triggering message. The comment-centric anchor
     *  only applies to a real `comment_added` ; a decision-event / lifecycle
     *  arriving by hint must NOT render as bare refs (empty body). */
    commentKind?: string;
}

/**
 * #1582 — may this hint anchor the wake at all?
 *
 * The precondition is content, not kind. Anchoring on a hint means rendering
 * ITS body, so a hint with nothing to render produces a wake reduced to
 * `(#N / #hashid)` — observed live on a `ticket_sub_added`, the bodyless
 * pseudo-comment that records a sub-ticket on its parent's thread.
 *
 * The previous guard asked the opposite question — "is this kind one of the
 * ones I know to be bodyless?" — over a list of three lifecycle kinds plus the
 * decision events. Such a list silently reopens on every new bodyless kind,
 * and it had already missed two (`ticket_sub_added`, `ticket_referenced`).
 * Asking whether there is text closes the family, including kinds nobody has
 * written yet, and also covers the case where the hint's fetch failed and
 * returned neither kind nor body.
 *
 * Pure so the guarantee is pinned by a test rather than by a code comment.
 */
export function hintHasRenderableBody(hint?: { commentBody?: string }): boolean {
    return !!hint?.commentBody?.trim();
}

/**
 * #1582 — the text a comment-centric head renders. **Never empty.**
 *
 * The FIFO half of the same bug: `ticket_sub_added` / `ticket_referenced` are
 * pseudo-comments whose body is `''`, so the head got a hashid and no text and
 * the wake came out as a bare `(#N / #hashid)`.
 *
 * Muting them instead would starve the queue: the seen mark happens at inject
 * time and an empty phrase is a hard skip, so the event would sit at the FIFO
 * head forever, re-picked and re-skipped, blocking everything behind it. On the
 * hint path suppression is safe because the FIFO is the fallback; the FIFO has
 * no fallback.
 *
 * Same fallback chain as `renderEventLine` — body, else a known label, else the
 * raw kind. Pure so "never empty" is pinned by a test rather than a comment.
 */
export function headTextFor(body: string | null | undefined, label: string | undefined, kind: string): string {
    const trimmed = typeof body === "string" ? body.trim() : "";
    if (trimmed) return stripMarkdown(trimmed);
    return label || kind || "update";
}

/**
 * #1351 — how many unread events the wake builder fetches to look for a
 * same-ticket bundle. The head is still the oldest (messages[0]); the rest
 * of the window is scanned for other unread events on the head's ticket so
 * they can be delivered in one wake instead of one turn each. A window, not
 * "all unread": bounds the cost, and any overflow simply surfaces on the
 * next wake.
 */
const WAKE_BUNDLE_FETCH_LIMIT = 30;

export async function buildContextPhrase(
    client: AiballClient,
    project: string | null,
    pingsAbsPath: string,
    eventHint?: WakeEventHint,
): Promise<ContextPhraseResult> {
    const culture = pickPingPhrase(pingsAbsPath);
    try {
        // #749 Phase B — drain HEAD unitaire. The wake "head" used to come
        // from `listTickets({claimable, assume_drained})` — the predicted
        // POST-drain top of the work-order. That fan-outed every wake
        // around the same actionable head even when N unread pings were
        // stacked, making the FIFO of pings invisible at the prompt layer.
        // New model : the head IS the oldest unread ping's ticket. One
        // wake = one ping (per david's body : "on prend le premier et on
        // dit comme le wake up en direct"). `client.unread(project, 1)`
        // returns the FIFO head Message (ASC by id, see listUnread). For
        // a ticket-pinger the message IS the ticket ; for a comment-pinger
        // we use its `ticket_id` parent — the agent claims the parent.
        // Pre-Phase-A the gate often resurfaced the same ticket post-drain
        // (no prune-on-consult), so the claimable-head was a safer bet.
        // With Phase A's prune, the unread FIFO drains naturally.
        const [pingsR, projects, unreadR, consumerR, standingR] = await Promise.all([
            client.pingsCount() as Promise<{ unread?: number }>,
            client.listProjectsDetailed() as Promise<Array<{
                name: string;
                open_count?: number;
                actionable_count?: number;
            }>>,
            // #800 david `unyzvx` : drop the project scoping. The wake FIFO
            // is consumer-scoped (cross-project) so a fan-out from another
            // project surfaces here. `project` arg dropped (passing null
            // = cross-project). When the head IS on another project, the
            // wake phrase template renders the bare ref without a project
            // prefix today — a future tweak can surface the project name.
            // #1351 — fetch a WINDOW (not just the head): the same-ticket
            // bundle folds every unread event of the head's ticket into one
            // wake. The head stays messages[0] (oldest, ASC by id); the rest
            // of the window lets us group. This also revives the #1163
            // decision digest, which never fired under the old limit=1.
            (client.unread(null, WAKE_BUNDLE_FETCH_LIMIT) as Promise<{
                messages?: Array<{
                    id: number;
                    kind?: string;
                    ticket_id?: number | null;
                    title?: string | null;
                    hashid?: string | null;
                    body?: string | null;
                    intent?: Intent | null;
                    meta?: string | null;
                    // #830 — narrowed shape carries by_agent + parent_message_id
                    // so the wake builder can route decision-event heads to
                    // their dedicated template branch (by_agent = decider,
                    // parent_message_id = original proposal id → hashid).
                    by_agent?: string | null;
                    parent_message_id?: number | null;
                    // #1820 — when the event happened. Already on the wire
                    // (listUnread filters on it); it was simply absent from
                    // this narrowed shape, so the wake could never say how
                    // old the thing it announces is.
                    created_at?: string | null;
                }>;
            }>).catch(() => ({ messages: [] })),
            // #397: this loop's own consumer row → its micro_prompt, exposed as
            // the `{consumer_prompt}` placeholder. Best-effort (null on failure).
            client.getConsumer(client.agentId).catch(() => null) as Promise<{ micro_prompt?: string | null } | null>,
            // #1832: the PROJECT's standing instruction. Fetched per wake, not
            // cached — the operator sets it precisely so the next wake carries
            // it. Null when the loop has no single project in scope, and
            // best-effort like the row above: a failed lookup costs the
            // reminder, never the wake.
            project
                ? (client.getProjectStandingPrompt(project).catch(() => null) as Promise<{ standing_prompt?: string | null } | null>)
                : Promise.resolve(null),
        ]);
        // Resolve the head's ticket id : a `ticket_created` msg IS the
        // ticket ; a `comment_added` / lifecycle msg points at it via
        // ticket_id. Title only populated for ticket roots ; comment-led
        // wakes show just #ID (the agent claims & reads the parent).
        const unreadHead = Array.isArray(unreadR?.messages) ? unreadR.messages[0] : undefined;
        const headRows: Array<{ id: number; title?: string; kind?: "comment" | "new ticket" }> = unreadHead
            ? (() => {
                const id = unreadHead.kind === "ticket_created"
                    ? unreadHead.id
                    : (unreadHead.ticket_id ?? 0);
                if (!id) return [];
                return [{
                    id,
                    title: unreadHead.kind === "ticket_created"
                        ? (unreadHead.title ?? undefined)
                        : undefined,
                    // #749 david `5qrrsd` : surface the event kind so the wake
                    // can say "comment on #X" / "new ticket #X" instead of a
                    // bare id. Lifecycle events (close/resolve/reopen) fall
                    // through to "comment" — close enough for the agent (the
                    // ping is still a thread update worth reading).
                    kind: unreadHead.kind === "ticket_created" ? "new ticket" : "comment",
                }];
            })()
            : [];
        const pingCount = typeof pingsR?.unread === "number" ? pingsR.unread : 0;
        // #397: per-consumer standing instruction. Empty when unset → the
        // `{consumer_prompt}` placeholder renders to nothing (opt-in; the
        // operator puts the placeholder in their wake template where they want).
        const consumerPrompt = (consumerR?.micro_prompt ?? "").trim();
        // #1832 — the project's standing instruction. Rendered BEFORE the
        // consumer's: the project one says "what matters here, right now", the
        // consumer one says "how you work in general", and the situational
        // instruction is the one that should be read first.
        const standingPrompt = (standingR?.standing_prompt ?? "").trim();
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
        if (pingCount === 0 && openCount === 0) return { phrase: culture, headMessageId: null, hasContent: false, backlogTicketId: null, extraSeenIds: [] };

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
        let head = Array.isArray(headRows) ? headRows[0] : undefined;
        // #749 — expose the unread head's discrete pieces as template
        // vars. We do NOT reuse `buildWakePhrase` here (that's the
        // SSE-driven "X just arrived" format) — the FIFO-pop wake is a
        // queue-head pointer, not an event notification.
        let headCommentHashid = "";
        let headBody = "";
        let headLifecycleVerb = "";
        // #1350 — per-consumer `claimable` of the head event's ticket, read
        // from the same best-effort getTicket that already fetches the title.
        // Drives the "(fyi — action non requise)" marker on event wakes.
        // #1350 david `9sxan3`/`ysufez` : the marker fires ONLY on the
        // `actionable && !claimable` case — a watcher who IS in the loop (the
        // ticket is in their court) but CANNOT act on it because they don't own
        // the project (cross-project consumer). NOT on `!claimable` alone : a
        // closed / tier-2 / tier-3 ticket is non-claimable too but is still the
        // recipient's own responsibility (e.g. #1355 closed → a bare `!claimable`
        // wrongly tagged it fyi). Both flags come from the same ticket header ;
        // `undefined` = unknown → no marker (fail toward the plain framing).
        let headClaimable: boolean | undefined;
        let headActionable: boolean | undefined;
        // #1351 — same-ticket bundle detection (computed BEFORE the empty-head
        // drop so a bundle survives even when its oldest event is a bare
        // comment). When ≥2 unread events concern the HEAD's ticket, they are
        // delivered as ONE wake instead of a turn per event.
        const unreadMsgs = Array.isArray(unreadR?.messages) ? unreadR.messages : [];
        const ticketIdOf = (m: (typeof unreadMsgs)[number]): number =>
            m?.kind === "ticket_created" ? (m.id ?? 0) : (m?.ticket_id ?? 0);
        const headTicketId = unreadHead ? ticketIdOf(unreadHead) : 0;
        // A = all unread events of the head's ticket within the window (david's
        // "concaténer les events d'un même ticket"), not just a contiguous run.
        const sameTicket = headTicketId
            ? unreadMsgs.filter((m) => ticketIdOf(m) === headTicketId)
            : [];
        const isBundleMode = sameTicket.length >= 2;
        // Head (oldest) id is returned as headMessageId + marked seen by the
        // inject site; the rest of the same-ticket run are the extras.
        const bundleExtraSeenIds: number[] = isBundleMode
            ? sameTicket
                .filter((m) => m.id !== unreadHead?.id)
                .map((m) => m.id)
                .filter((v): v is number => typeof v === "number")
            : [];
        // #1554 — expose the wake's ticket + the DISTINCT-ticket count of the
        // delivered bundle for wake:diag. `sameTicket` is filtered to
        // `headTicketId`, so the count is 1 by construction; a value >1 would be
        // the "multiple tickets in one wake" bug this instruments for.
        const wakeTicketId = headTicketId || null;
        const bundleTicketCount = isBundleMode
            ? new Set(sameTicket.map(ticketIdOf)).size
            : (headTicketId ? 1 : 0);
        // Drop empty comments without a pending decision. The FIFO head
        // must carry actionable content (body, or a pending decision
        // proposal); otherwise treat as missing so the wake falls
        // through to the idle branch instead of emitting "(#X / #Y)".
        // #1351 — but never drop when a bundle is being assembled (the bundle
        // shows refs, so an empty oldest event is still a listed update).
        if (unreadHead && unreadHead.kind === "comment_added" && !isBundleMode) {
            const meta = typeof unreadHead.meta === "string"
                ? (() => { try { return JSON.parse(unreadHead.meta as string); } catch { return null; } })()
                : null;
            const hasPendingDecision = meta?.decision?.status === "pending";
            const hasBody = typeof unreadHead.body === "string" && unreadHead.body.trim().length > 0;
            if (!hasBody && !hasPendingDecision) {
                head = undefined;
            }
        }
        // Lifecycle heads (close / reopen / resolve) emit their own verb.
        // The agent's discipline skill decides what to do with a closed
        // ticket; the wake just announces the state change with the ref.
        const LIFECYCLE_VERBS: Record<string, string> = {
            ticket_closed: "closed",
            ticket_resolved: "resolved",
            ticket_reopened: "reopened",
        };
        // #830 david `a7pn65` — decision events get their own wake branch
        // so the agent's prompt explicitly carries "Your plan on #X was
        // accepted by david" instead of re-pulling the original proposal
        // body unchanged. Each kind maps to a dedicated phrase prefix ;
        // the wake template's `head_decision_event` branch renders the
        // full sentence around it.
        // #892 david : phrasings explicites sur l'effet ticket. Avant on
        // disait juste "Your resolution was ACCEPTED" → ambiguous (plan ?
        // ticket clos ?). Maintenant chaque phrase précise l'état.
        // #912 david `a8uupb` : REJECT en prefix (sans emoji) — option B
        // sans la croix. Les 4 phrases reject mettent désormais "REJECT"
        // en tête de phrase pour qu'il soit immédiatement visible dans
        // l'inject prompt (pas noyé entre "Your" et le reste).
        // Per-kind wake phrasings for the two terminal transitions. Keyed on
        // DecisionKind (Record<DecisionKind, …>) so a new decision verb can't
        // ship without its wording — TS forces the entry. The flat
        // `<kind>_<transition>` → phrase map the branches read is built from it.
        // #1577 david `pmuc8p` — IMPERSONAL wording. These phrases said "Your
        // plan…", but the same event reaches the ticket's REPORTER, who is not
        // always the decision's author: on a ticket handed to another agent,
        // the reporter was told "Your plan was ACCEPTED — execute" about
        // someone else's plan, on a ticket that agent holds a live claim on.
        // "The" states the fact without assigning it to the reader; who should
        // act follows from the claim and from `poll().plans_to_execute`, not
        // from a possessive in a sentence.
        const DECISION_VERB_PHRASES: Record<DecisionKind, { accepted: string; rejected: string }> = {
            plan: { accepted: "The plan was ACCEPTED — execute", rejected: "REJECT — the plan, ball back in its author's court" },
            resolution: { accepted: "The resolution was ACCEPTED, ticket closed", rejected: "REJECT — the resolution, ticket stays open" },
            wontfix: { accepted: "The wontfix was ACCEPTED, ticket closed", rejected: "REJECT — the wontfix, ticket stays open" },
            escalation: { accepted: "The escalation was ACCEPTED", rejected: "REJECT — the escalation" },
        };
        const DECISION_EVENT_VERBS: Record<string, string> = Object.fromEntries(
            DECISION_KINDS.flatMap((k): Array<[string, string]> => [
                [`${k}_accepted`, DECISION_VERB_PHRASES[k].accepted],
                [`${k}_rejected`, DECISION_VERB_PHRASES[k].rejected],
            ]),
        );
        const unreadKind = unreadHead?.kind ?? "";
        // #1351 — same-ticket bundle. When ≥2 unread events concern the HEAD's
        // ticket, deliver them as ONE wake (compact refs, newest on top /
        // oldest at the bottom) instead of a turn per event. This SUPERSEDES
        // the #1163 decision-only digest, which never fired in prod: the fetch
        // was capped at limit 1, so its `run.length >= 2` was unreachable.
        // Events stay unitary in DB — only DELIVERY groups; `bundleExtraSeenIds`
        // marks the folded-in events seen alongside the head. Labels: decisions
        // keep their #1163 wording; comment/lifecycle/new-ticket get a compact
        // token. Body is intentionally dropped in bundle mode (refs only) —
        // the single-event wake still carries the full body.
        // Compact digest labels are mechanical (`<kind> ACCEPTED|REJECT`), so
        // derive them from DECISION_KINDS — a new verb is auto-labelled.
        const DIGEST_LABELS: Record<string, string> = Object.fromEntries(
            DECISION_KINDS.flatMap((k): Array<[string, string]> => [
                [`${k}_accepted`, `${k} ACCEPTED`],
                [`${k}_rejected`, `${k} REJECT`],
            ]),
        );
        const BUNDLE_LABELS: Record<string, string> = {
            ...DIGEST_LABELS,
            // lifecycle labels are the SAME strings as LIFECYCLE_VERBS — spread
            // it instead of re-typing closed/resolved/reopened by hand.
            ...LIFECYCLE_VERBS,
            comment_added: "comment",
            ticket_created: "new ticket",
            // #1582 — the two bodyless pseudo-comments. Without a label they
            // fall back to their raw snake_case kind, which is readable but
            // reads like a leak; these follow the convention of the two above.
            ticket_sub_added: "sub-ticket added",
            ticket_referenced: "referenced",
        };
        // #1351 + #1363 — render ONE event as a compact line, SAME content as
        // its standalone wake : a comment shows its markdown-stripped body
        // (truncated like a single-comment wake, `stripMarkdown` default 240) ;
        // lifecycle / decision / new-ticket events have no body → keep their
        // descriptive label ("closed", "resolution ACCEPTED", …). Shared by the
        // same-ticket bundle (#1351) and the backlog CTA's last-event line
        // (#1363 david `futbsc` — show what happened instead of asserting
        // "<actor> is waiting on your reply", let the agent judge).
        const renderEventLine = (m: { kind?: string; body?: string | null; hashid?: string | null; by_agent?: string | null }): string => {
            const body = typeof m?.body === "string" ? m.body : "";
            const base = m?.kind === "comment_added" && body.trim()
                ? stripMarkdown(body)
                : (m?.kind && BUNDLE_LABELS[m.kind]) || m?.kind || "update";
            const ref = typeof m?.hashid === "string" && m.hashid ? ` (#${m.hashid})` : "";
            const by = m?.by_agent ? ` by ${m.by_agent}` : "";
            return `${base}${ref}${by}`;
        };
        // Built once the head's title is resolved (below). Empty = no bundle.
        // Detection (`isBundleMode`, `sameTicket`, `bundleExtraSeenIds`) ran
        // above, before the empty-head drop.
        let headBundle = "";
        // In bundle mode the single-event branches are suppressed — only the
        // bundle renders. Otherwise the head keeps its normal single-event
        // rendering (comment body / lifecycle / decision-event).
        if (unreadKind && LIFECYCLE_VERBS[unreadKind] && !isBundleMode) {
            headLifecycleVerb = LIFECYCLE_VERBS[unreadKind];
        }
        // Resolve the decision-event phrase + decider when the unread
        // head is one of the 8 new kinds. Empty string when not.
        let headDecisionEvent = "";
        let headDecisionDecider = "";
        let headDecisionRefHashid = "";
        if (unreadKind && DECISION_EVENT_VERBS[unreadKind] && !isBundleMode) {
            headDecisionEvent = DECISION_EVENT_VERBS[unreadKind];
            headDecisionDecider = unreadHead?.by_agent ?? "";
            // Look up the original proposal hashid via the parent_id link
            // so the agent can navigate back to its own comment.
            const parentId = unreadHead?.parent_message_id ?? null;
            if (parentId && typeof parentId === "number") {
                try {
                    const parent = await client.getMessage(parentId) as { hashid?: string | null };
                    if (typeof parent.hashid === "string" && parent.hashid) {
                        headDecisionRefHashid = parent.hashid;
                    }
                } catch { /* best-effort */ }
            }
        }
        if (unreadHead && head?.id) {
            const isTicketRoot = unreadKind === "ticket_created";
            const isLifecycle = !!LIFECYCLE_VERBS[unreadKind];
            const isDecisionEvent = !!DECISION_EVENT_VERBS[unreadKind];
            if (!isBundleMode && !isTicketRoot && !isLifecycle && !isDecisionEvent && typeof unreadHead.hashid === "string") {
                headCommentHashid = unreadHead.hashid;
            }
            if (!isBundleMode && !isTicketRoot && !isLifecycle && !isDecisionEvent) {
                // #1582 — the head is rendered comment-centric, so it MUST carry
                // text. `ticket_sub_added` / `ticket_referenced` are pseudo-
                // comments with `body: ''`: the hashid above was set, this stayed
                // empty, and the wake came out as a bare `(#N / #hashid)`.
                //
                // Suppressing the hashid instead would be worse: the seen mark
                // happens at inject time and an empty phrase is a hard skip, so
                // the event would sit at the FIFO head forever, re-picked and
                // re-skipped, starving everything behind it. Render, don't mute.
                //
                // Same fallback chain as `renderEventLine` (the bundle + backlog
                // last-event line): body when there is one, else a known label,
                // else the raw kind. Never nothing.
                headBody = headTextFor(unreadHead.body, BUNDLE_LABELS[unreadKind], unreadKind);
            }
            // Title lookup for comment heads (the unread row doesn't carry
            // the parent ticket's title). Best-effort getTicket.
            if (!head.title && !isTicketRoot) {
                try {
                    const t = await client.getTicket(head.id, { summary: true }) as {
                        ticket?: { title?: string | null; claimable?: boolean; actionable?: boolean };
                    };
                    const title = t.ticket?.title;
                    if (typeof title === "string" && title) head = { ...head, title };
                    // #1350 — piggyback the actionable + claimable flags (same
                    // fetch, no extra round-trip) for the fyi marker on this
                    // event wake (fires on `actionable && !claimable`).
                    if (typeof t.ticket?.claimable === "boolean") headClaimable = t.ticket.claimable;
                    if (typeof t.ticket?.actionable === "boolean") headActionable = t.ticket.actionable;
                } catch { /* best-effort */ }
            } else if (isTicketRoot && !head.title && unreadHead.title) {
                head = { ...head, title: unreadHead.title };
            }
        }
        // #1351 — assemble the same-ticket bundle now the head's title is
        // resolved. Each line carries its own hashid so the agent can open any
        // single event.
        // #1351 david `36phxd` — a bundled line carries the SAME content as its
        // standalone wake (via `renderEventLine`) ; only the DELIVERY differs.
        // #1408 david — chronological order, oldest first / newest at the
        // bottom. The window is already ASC (oldest first, same as
        // `client.unread()`), so render it as-is — no reverse. This matches a
        // human reading a thread top-down and the head (messages[0], the oldest)
        // stays the line the agent anchors on.
        if (isBundleMode) {
            const lines = sameTicket.map((m) => renderEventLine(m)).join("\n");
            const titlePart = head?.title ? `: ${head.title}` : "";
            headBundle = `#${headTicketId}${titlePart} — ${sameTicket.length} updates:\n${lines}`;
        }
        // #999 — event-triggered wake (SSE hint present) : anchor the phrase
        // on the hint's comment so it renders COMMENT-centric (body + ref)
        // even when the FIFO already pruned/raced past this ping. We only
        // anchor when the FIFO didn't already surface an event branch — the
        // FIFO head is fresher and authoritative when present ; the hint is
        // the safety net for the empty-FIFO case that used to fall through to
        // the backlog branch (the bug). The backlog ticket-centric "Triage"
        // branch is reserved for the no-hint heartbeat path (gated below).
        // #1169 — n'ancrer sur le hint QUE si c'est un vrai comment_added.
        // Un decision-event / lifecycle arrivé par hint (body vide) rendrait
        // « (#N / #hashid) » nu ; on le laisse tomber → l'empty-phrase guard
        // skippe le wake proprement, et l'event ressurgit via le FIFO (où sa
        // branche decision-event rend « The resolution was ACCEPTED »).
        // #1569 — true when the wake anchors on the hint instead of the FIFO
        // head. Drives what gets marked seen: we must ack what we RENDER.
        let hintAnchored = false;
        const hintIsComment = eventHint?.commentKind
            ? (!DECISION_EVENT_VERBS[eventHint.commentKind] && !LIFECYCLE_VERBS[eventHint.commentKind]
                && eventHint.commentKind !== "ticket_created")
            : true; // kind inconnu (hint legacy) : comportement inchangé
        // #1582 — et surtout : le hint doit avoir QUELQUE CHOSE À DIRE.
        //
        // `hintIsComment` ci-dessus est une liste noire de kinds réputés sans
        // corps. Elle en listait trois lifecycle + les décisions + ticket_created,
        // et ratait `ticket_sub_added` — un pseudo-commentaire (trace de
        // sous-ticket sur le fil parent, messages.ts) dont le body est `''` par
        // construction. Résultat observé : un wake réduit à « (#1571 / #edxf9s) ».
        // `ticket_referenced` a la même forme et portait le même bug.
        //
        // Une liste noire de kinds sans corps se rouvre à chaque nouveau kind
        // sans corps, en silence. La précondition, elle, est fermée : on
        // n'ancre que si le hint porte du texte. Les deux cohabitent parce
        // qu'elles répondent à des questions différentes — `hintIsComment` dit
        // QUELLE BRANCHE doit rendre l'événement, `hintHasBody` dit s'il y a
        // matière à rendre.
        //
        // Ça ferme aussi un troisième chemin : quand `wake-context` échoue, il
        // renvoie ni kind ni body — le kind inconnu passait par la branche
        // « comportement inchangé » et s'ancrait sur du vide.
        const hintHasBody = hintHasRenderableBody(eventHint);
        if (eventHint?.commentHashid && hintIsComment && hintHasBody
            && !headCommentHashid && !headLifecycleVerb && !headDecisionEvent
            && head?.kind !== "new ticket") {
            headCommentHashid = eventHint.commentHashid;
            if (eventHint.commentBody) headBody = eventHint.commentBody;
            // #1569 (david `fdsw2h`) — the hint's hashid and body are grafted
            // unconditionally, so the TICKET has to follow. It used to be adopted
            // only `if (!head?.id)`: when the FIFO already held a head from
            // ANOTHER ticket, its number was kept while the hint supplied the
            // body — rendering `(#head / #hint-hashid)`, a pair that never
            // existed. That's the "artificial glue": a bundle of two tickets the
            // same-ticket bundler would never have built.
            //
            // Rule A (david's accept): an event wake anchors on its event, whole
            // — ticket included. This just finishes what #999 already intended
            // ("anchored on that event"). The FIFO head is left UNREAD and comes
            // back on the next wake, so nothing is lost by preferring the hint.
            if (!head?.id || head.id !== eventHint.ticketId) {
                hintAnchored = true;
                head = { id: eventHint.ticketId, title: undefined, kind: "comment" };
                // The hint doesn't carry the parent ticket title — best-effort.
                try {
                    const t = await client.getTicket(eventHint.ticketId, { summary: true }) as {
                        ticket?: { title?: string | null };
                    };
                    const title = t.ticket?.title;
                    if (typeof title === "string" && title) head = { ...head, title };
                } catch { /* best-effort */ }
            }
        }
        // When the FIFO is empty, fall back to the top backlog ticket.
        // ?backlog=1 returns the two-tier set: actionable first (ball in
        // my court), then open AND I-was-last-actor (ball in theirs).
        // The work-order tiering puts tier 1 first; limit:1 picks the
        // first of either tier. Respects no-claim semantics: a consumer
        // with consumer.can_claim=false has an empty actionable tier and
        // only surfaces tier-2 reminders where they were last actor.
        // #999 — `!eventHint` : an event wake never enters the backlog
        // fallback (its format is comment-centric, anchored above).
        let headLastComment = "";   // #1215/#1363 — backlog head's last event line (author ≠ me), for the CTA
        // #1470 — the backlog head's tier, so the CTA can ask the RIGHT question.
        // The backlog deliberately rotates aged context back into view (it sinks
        // temporarily to let agents breathe); the pressure is wanted. What was
        // wrong is the instruction: "Triage the ticket" on a tier-2/3/4 head made
        // the agent re-derive the gate and answer "standby", which doesn't move
        // `last_actor` — so it re-fired unchanged. Naming the tier turns that turn
        // into the re-examination the rotation exists for. null = unknown (older
        // daemon) → the template falls back to the plain triage wording.
        let headTier: number | null = null;
        if (!head && pingCount === 0 && openCount > 0 && !eventHint) {
            try {
                // /api/tickets returns a raw JSON array, not an envelope.
                // backlog=1 returns the two-tier set documented in
                // docs/TICKET_LIFECYCLE.md §5.0 — tier 1 (actionable / ball
                // in my court) sorted first, then tier 2 (open AND I was
                // the last actor / ball in theirs). Tickets neither in
                // tier 1 nor tier 2 are dropped server-side. Gate on the
                // broader openCount so tier-2 reminders still surface
                // when actionable_count is zero.
                // #786 — pass the per-loop cooldown so the daemon excludes
                // tickets we just named and that haven't moved since.
                const cooldownSec = Math.max(0, Number(process.env[CL_ENV.BACKLOG_COOLDOWN_SEC] ?? 3600));
                // #910 david : pull plus que `limit:1` puis filter en local
                // les tickets en cooldown (`backlog_cooled_until` set). Le
                // daemon ne filtre PAS les cooled côté API (intentionnel
                // pour que le CLI les affiche en section dédiée), donc avec
                // `limit:1` un ticket cooled monopolise le head et le wake
                // CTA re-fire dessus alors que le user CLI ne le voit
                // même plus dans le backlog. Aligne le picker sur le CLI :
                // pick le premier NON-cooled (= comportement attendu).
                // #1355 — `limit:"500"` (was 10) mirrors the bar-counter query
                // (kernel.ts refreshCounters). With 10, ≥10 cooled tickets
                // sorted ahead of the sole non-cooled head made the picker miss
                // it → head null → no wake, while the counter (500) still saw it
                // → b:1 armed the decount → phantom loop. Same cap on both ends.
                const raw = await client.listTickets({
                    ...(project ? { project } : {}),
                    backlog: "1",
                    limit: "500",
                    cooldown_sec: cooldownSec > 0 ? String(cooldownSec) : undefined,
                });
                type BacklogRow = {
                    id: number;
                    title?: string | null;
                    backlog_cooled_until?: string | null;
                    last_actor?: string | null;
                    actionable?: boolean;
                    claimable?: boolean;
                    /** #1470 — drives the tier-aware CTA (see `headTier`). */
                    backlog_tier?: number | null;
                };
                const rows: BacklogRow[] = Array.isArray(raw)
                    ? (raw as BacklogRow[])
                    : ((raw as { tickets?: BacklogRow[]; rows?: BacklogRow[] })?.tickets
                        ?? (raw as { rows?: BacklogRow[] })?.rows
                        ?? []);
                // #1350 slice 2 — the backlog "Triage" CTA must only surface a
                // head the agent can actually CLAIM. The backlog set is
                // actionable ∪ last-actor-me, NOT filtered by claimable, so a
                // cross-project ticket that is actionable-but-not-claimable
                // (ball technically in my court, but a project I don't own)
                // would fire "look #N… Triage" that `ticket_claim` can't act
                // on. Skip exactly that case: `actionable && claimable===false`.
                // We do NOT skip non-actionable heads (tier-2 my-pending-decision
                // / tier-3 I-was-last-actor reminders) — those are legitimate
                // own reminders and are non-claimable by construction. Fail-open:
                // undefined flags (older daemon) keep the current behavior.
                const top = rows.find(
                    (r) => !r.backlog_cooled_until && !(r.actionable === true && r.claimable === false),
                );
                if (top && Number.isFinite(top.id)) {
                    head = { id: top.id, title: top.title ?? undefined, kind: undefined };
                    headTier = typeof top.backlog_tier === "number" ? top.backlog_tier : null;
                    // #1363 david `futbsc` — when the head's last actor isn't me,
                    // SHOW that last event's content (a bundle-style line) instead
                    // of asserting "<actor> is waiting on your reply". The old
                    // assertion (#1215) fired on ANY last_actor ≠ me, so a plain
                    // human confirmation ("j'ai fermé X") read as a pending reply
                    // it never was. Showing the content lets the agent read it and
                    // judge whether a reply is owed — no intent heuristic. Only for
                    // last_actor ≠ me (tier-1 ball-in-my-court) ; tier-3 reminders
                    // where I was last actor keep the plain look.
                    const la = top.last_actor;
                    if (la && la !== process.env.AIBALL_AGENT) {
                        try {
                            const resp = await client.getTicket(top.id, { summary: false, limit: 1, order: "desc" }) as {
                                comments?: Array<{ kind?: string; body?: string | null; hashid?: string; by_agent?: string | null }>;
                            };
                            const last = Array.isArray(resp.comments) ? resp.comments[0] : undefined;
                            if (last) headLastComment = renderEventLine(last);
                        } catch { /* fail-open : no last-event line, CTA stays neutral */ }
                    }
                }
            } catch { /* fail-open : no head, template drops the look leg */ }
        }
        // Backlog fallback head may also be missing its title (older daemons,
        // or stripped projection). One small getTicket fills it in so the
        // engage leg can render `#X "TITLE"`.
        if (head?.id && !head.title) {
            try {
                const t = await client.getTicket(head.id, { summary: true }) as { ticket?: { title?: string | null } };
                const title = t.ticket?.title;
                if (typeof title === "string" && title) {
                    head = { ...head, title };
                }
            } catch { /* best-effort */ }
        }
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
        // #749 — backlog branch fires when an open head is available
        // (FIFO empty, at least one open ticket). The agent's discipline
        // skill decides whether to claim or just triage.
        // #999 — `!eventHint` reserves the backlog ticket-centric branch for
        // the no-hint heartbeat path. An event-triggered wake renders the
        // event branch (comment/lifecycle/decision/new-ticket) or, if nothing
        // resolved, no_head (empty phrase → the wake gate refuses to inject) —
        // never a misleading "look #N… Triage" for a concrete event.
        const backlogMode = (pingCount === 0 && hasClaimableHead && !blocking && !eventHint)
            ? "1" : "";
        // #1350 — role-conditioned "(fyi — action non requise)" marker on EVENT
        // wakes (comment / lifecycle / decision-event / bundle). Fires on the
        // `actionable && !claimable` case only : the consumer is in the loop
        // (ball in their court) but can't act because they don't own the project
        // (cross-project watcher). A closed / tier-2 / tier-3 ticket is
        // non-claimable too but stays the recipient's own responsibility → no
        // marker. The backlog CTA is untouched (already gated to claimable
        // heads); a new-ticket wake stays as-is (not in scope).
        const headIsEvent = !!(headCommentHashid || headLifecycleVerb || headDecisionEvent || headBundle);
        if (headIsEvent && (headClaimable === undefined || headActionable === undefined) && head?.id) {
            // Defensive fill for the paths that set an event branch without the
            // title fetch above (e.g. the hint-anchored comment with a head
            // already resolved). Best-effort — failure leaves no marker.
            try {
                const t = await client.getTicket(head.id, { summary: true }) as {
                    ticket?: { claimable?: boolean; actionable?: boolean };
                };
                if (typeof t.ticket?.claimable === "boolean") headClaimable = t.ticket.claimable;
                if (typeof t.ticket?.actionable === "boolean") headActionable = t.ticket.actionable;
            } catch { /* best-effort — no marker on failure */ }
        }
        const headFyi = headIsEvent && headActionable === true && headClaimable === false ? "1" : "";
        const vars = {
            culture,
            ping_count: pingCount || "",
            open_count: openCount || "",
            // #428: a blocking gate hides the claim directive ("don't take new work").
            // #516 : aussi caché quand pas de head claimable post-drain.
            actionable_count: (blocking || !hasClaimableHead) ? "" : (actionableCount || ""),
            head_id: head?.id ?? "",
            head_title: head?.title ?? "",
            // head_kind fires only for the ticket_created case so the
            // ticket-led template branch doesn't double-fire when the head
            // is a comment or a lifecycle event.
            head_kind: head?.kind === "new ticket" && !headCommentHashid && !headLifecycleVerb ? head.kind : "",
            // head_lifecycle = the verb (closed / resolved / reopened)
            // when the FIFO head is a lifecycle event; "" otherwise.
            head_lifecycle: headLifecycleVerb,
            // no_head = "1" when none of the five head branches fire
            // (comment, new ticket, lifecycle, decision-event, backlog).
            // The template grammar lacks an else-empty operator so the
            // inversion lives here.
            no_head: (!headCommentHashid && head?.kind !== "new ticket" && !headLifecycleVerb && !headDecisionEvent && !headBundle && !backlogMode) ? "1" : "",
            backlog_mode: backlogMode,
            head_comment_hashid: headCommentHashid,
            head_body: headBody,
            // #830 — decision event branch vars. head_decision_event is the
            // pre-formatted phrase ("The plan was ACCEPTED" etc.) ; the
            // wake template wraps it with the ticket ref + decider + the
            // original proposal hashid for navigation.
            head_decision_event: headDecisionEvent,
            // #1163 S2 — pré-formaté comme head_decision_event ; branche
            // mutuellement exclusive (le single est éteint quand le digest fire).
            // #1351 — the same-ticket bundle (multi-line, compact refs).
            // Supersedes the #1163 `head_decision_digest` (decisions are one
            // kind of bundled event now).
            head_bundle: headBundle,
            head_decision_decider: headDecisionDecider,
            head_decision_ref_hashid: headDecisionRefHashid,
            // #1820 — age of the announced event, empty while it is fresh.
            // One source covers both cases david named: a decision event is
            // a real server-emitted row (`/decide` only), so its own
            // created_at IS the moment of the decision — no need to reach
            // into the original proposal's `decided_at`.
            head_age: formatWakeStamp(unreadHead?.created_at, Date.now()),
            project_scope: scope,
            // #1215 david `go` — le CTA backlog reflète qu'un commentaire attend
            // une réponse en NOMMANT le dernier acteur (≠ moi). Remplace l'ancien
            // `state_time` (horloge HH:MM, #1158) jugé illisible : « <acteur> is
            // waiting on your reply » porte l'info utile. "" quand tier-2 (j'étais
            // le dernier acteur) → le look reste neutre.
            head_last_comment: headLastComment,
            // #1470 — tier of the backlog head, exposed as a SIGNAL so the
            // template (not code) decides the wording. The grammar has no
            // else-operator, so the "plain triage" inversion is computed here —
            // same convention as `no_head` above. Only one ever fires.
            head_tier: backlogMode && headTier !== null ? String(headTier) : "",
            head_tier_triage: backlogMode && (headTier === null || headTier <= 1) ? "1" : "",
            head_tier_followup: backlogMode && headTier === 2 ? "1" : "",
            head_tier_waiting: backlogMode && headTier === 3 ? "1" : "",
            head_tier_blocked: backlogMode && headTier === 4 ? "1" : "",
            // #1350 — "1" when the head EVENT wake is for a ticket this consumer
            // isn't responsible for (non-claimable). The template appends
            // "(fyi — action is not mandatory)" to the comment/lifecycle/
            // decision branches so a watcher isn't pushed to over-act.
            head_fyi: headFyi,
            // #1832: {standing_prompt} = the PROJECT's standing instruction,
            // rendered at the head of every wake — event and backlog alike,
            // since it precedes the mutually exclusive branches rather than
            // living inside one. Empty → renders to nothing, so a project
            // without one gets byte-identical wakes.
            standing_prompt: standingPrompt,
            // #397: {consumer_prompt} = this consumer's micro-prompt (opt-in;
            // empty → renders to nothing).
            //
            // #1832 — until now NO shipped template rendered this, so the
            // field was editable in the UI, fetched on every wake, and thrown
            // away. It is placed in the default template alongside the project
            // one, which costs a token and revives it. David's instruction was
            // explicit: do not REPAIR it if that turns out not to be enough.
            // The feature he asked for is the project-scoped instruction; this
            // one is a nearly-free bonus, and a bonus does not justify digging.
            consumer_prompt: consumerPrompt,
        };
        // Unified FIFO-pop wake. Five mutually exclusive branches:
        //   comment    →  body + refs only
        //   new ticket →  "new ticket #ID: TITLE"
        //   lifecycle  →  "#ID VERB: TITLE"   (closed / resolved / reopened)
        //   decision   →  "Your <kind> was <verb> on #ID: TITLE by X (#hashid)"
        //                  (#830 david `a7pn65` — 8 kinds, plan/resolution/
        //                  wontfix/escalation × accepted/rejected)
        //   backlog    →  culture + "look #ID: TITLE. Triage the ticket."
        // #825 david `b63ez5` : drop the `no_head` cultural ping entirely.
        // Strict binary rule on the wake firing side (timer.ts:tryWake) —
        // fire ONLY on event OR backlog.
        const wakeMasterDefault =
            // #1350 david `9sxan3`/`ysufez` — the marker lives INSIDE the ref
            // parenthesis, not as a free prefix (a prefix reads as a second,
            // duplicated parenthesis next to the ref). For the comment branch it
            // folds into the ref `(fyi — action is not mandatory · #ID / #hash)`;
            // for lifecycle/decision/bundle (no natural trailing ref paren) it's
            // a single suffix paren. Still truncation-safe : `head_body` is
            // truncated upstream and the ref paren is template-appended after it,
            // so the marker (inside that paren) always survives.
            // #1832 — the standing instructions lead, before the five
            // mutually exclusive head branches. That placement is what
            // makes them show on an EVENT wake and a BACKLOG wake alike:
            // a prefix precedes branches, it does not pick one.
            "{standing_prompt:+{standing_prompt} · }{consumer_prompt:+{consumer_prompt} · }"
            + "{head_comment_hashid:+{head_body:+{head_body} }({head_fyi:+fyi — action is not mandatory · }#{head_id} / #{head_comment_hashid}{head_age:+ · {head_age}})}"
            + "{head_kind:+new ticket #{head_id}{head_title:+: {head_title}}{head_age:+ · {head_age}}}"
            + "{head_lifecycle:+#{head_id} {head_lifecycle}{head_title:+: {head_title}}{head_age:+ · {head_age}}{head_fyi:+ (fyi — action is not mandatory)}}"
            + "{head_decision_event:+{head_decision_event} on #{head_id}{head_title:+: {head_title}}{head_decision_decider:+ by {head_decision_decider}}{head_decision_ref_hashid:+ (#{head_decision_ref_hashid})}{head_age:+ · {head_age}}{head_fyi:+ (fyi — action is not mandatory)}}"
            + "{head_bundle:+{head_bundle}{head_age:+ · {head_age}}{head_fyi:+ (fyi — action is not mandatory)}}"
            // #1470 — the backlog leg closes with a TIER-AWARE instruction. The
            // rotation (and its pressure) is unchanged: same head, same cadence.
            // Only the ask changes, so a re-surfaced ticket gets the re-examination
            // it was rotated back for instead of a reflex "standby".
            + "{backlog_mode:+{culture} look #{head_id}{head_title:+: {head_title}}.{head_last_comment:+ — {head_last_comment}.}"
            + "{head_tier_triage:+ Triage the ticket.}"
            + "{head_tier_followup:+ Your pending decision is what gates this — re-examine whether it's still the right scope instead of just acking.}"
            + "{head_tier_waiting:+ You spoke last: re-surfaced so you re-check it — chase them, or let it ride.}"
            + "{head_tier_blocked:+ Blocked by an open dependency — re-check the chain: the blocker may be snoozed or stale.}}";
        let cta = renderSlot(promptMap, "wake_master", vars, wakeMasterDefault, tone);
        // #751-followup (urgent fix : david's stale `wake_master` override
        // missed the `head_decision_event` branch added by #830 and produced
        // empty phrases for plan_accepted / resolution_rejected / etc. events,
        // stuck-state cascading via the empty-phrase guard in timer.ts).
        // Safety net : if a user template returned EMPTY but a head branch is
        // actually active, re-render with the in-code default which is guaranteed
        // to cover all 5 branches. The user template still WINS when it produces
        // non-empty output ; only the missing-branch case falls back.
        const hasHead = !!(headCommentHashid || headLifecycleVerb || headDecisionEvent
            || headBundle || head?.kind === "new ticket" || backlogMode);
        if (!cta && hasHead) {
            cta = renderSlot({}, "wake_master", vars, wakeMasterDefault, tone);
        }
        // #428: prepend the triggered-gate banner. Built-in messages render via
        // their prompt slot (per-project overridable + tone-aware + {vars});
        // custom gates use their literal message / cmd stdout. Template-agnostic
        // (works even when a custom wake_master has no {gates} placeholder).
        // headMessageId carries the inject-time prune target. Only the
        // FIFO-driven branch has a real id; backlog and idle paths set
        // null so the inject site doesn't try to prune nothing.
        // #1569 — when the wake anchored on the hint, the FIFO head was NOT
        // shown, so acking it would silently swallow an event. Point at the
        // hint's own message instead (null when the hint carries no id:
        // better to re-deliver than to ack blind).
        const headMessageId = hintAnchored
            ? (eventHint?.commentId ?? null)
            : (unreadHead?.id ?? null);
        // Same reasoning for the bundle extras and the diag: they describe the
        // FIFO head's ticket, which is not what we rendered.
        const effExtraSeenIds = hintAnchored ? [] : bundleExtraSeenIds;
        const effWakeTicketId = hintAnchored ? (eventHint?.ticketId ?? null) : wakeTicketId;
        const effBundleTicketCount = hintAnchored ? 1 : bundleTicketCount;
        // hasContent flags whether one of the actionable branches fired
        // (FIFO comment, lifecycle, new ticket, or backlog). When false
        // the phrase is just the idle culture+lead — drain-style wake
        // reasons skip on it.
        const hasContent = !!(headCommentHashid || headLifecycleVerb || headDecisionEvent || headBundle || head?.kind === "new ticket" || backlogMode);
        // #786 — surface the backlog-branch ticket id so the inject site
        // can start the per-consumer cooldown clock. Only when the
        // backlog branch actually fired (not on FIFO / lifecycle).
        const backlogTicketId = (backlogMode && head?.id) ? head.id : null;
        if (gateResults.length === 0) return { phrase: cta, headMessageId, hasContent, backlogTicketId, extraSeenIds: effExtraSeenIds, wakeTicketId: effWakeTicketId, bundleTicketCount: effBundleTicketCount };
        const banner = gateResults
            .map((g) => (g.slot ? renderSlot(promptMap, g.slot, g.vars, g.message, tone) : g.message))
            .join("  ");
        return {
            phrase: `${blocking ? "🛑 " : ""}${banner}  ${cta}`,
            headMessageId,
            // A triggered gate counts as content even if the FIFO is empty.
            hasContent: hasContent || gateResults.length > 0,
            backlogTicketId,
            extraSeenIds: effExtraSeenIds,
            wakeTicketId: effWakeTicketId,
            bundleTicketCount: effBundleTicketCount,
        };
    } catch {
        return { phrase: culture, headMessageId: null, hasContent: false, backlogTicketId: null, extraSeenIds: [] };
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
 * Two delivery strategies, NOT a fallback chain (#974) :
 *  - **proxy loops** (loop.sock present / proxyIsAlive on win) : the
 *    inject IS the channel. Success → return true. A full failure =
 *    proxy bug to investigate, NOT to paper over with tmux send-keys
 *    (which re-arms NOT AFK 10m via the keystroke detector) → return
 *    false so the caller logs loud + drops the wake.
 *  - **non-proxy loops** (no loop.sock) : tmux paste-buffer + standalone
 *    Enter (mirrors `tryPanic`), with a plain `send-keys` if set-buffer
 *    failed. The documented normal path for those loops, not a degraded
 *    fallback → return true.
 *
 * Returns true when the wake was delivered (either strategy), false when
 * a proxy was expected but the inject failed (caller logs loud — #974).
 *
 * Used by every wake site: session-start-hook, stop-hook post-turn
 * wake, timer no-hint wake, and SSE-hinted wakes — short phrases pay
 * a ~200ms latency but consistency beats branching on length.
 */
export async function injectWakePhrase(
    paneTarget: string,
    phrase: string,
    onWillInject?: () => void,
): Promise<boolean> {
    // #269: when the pane runs under the PTY proxy, deliver the wake
    // straight to claude's PTY via the proxy's control channel — that
    // bypasses tmux/psmux stdin, so the proxy's human-typing detector
    // never mistakes our own injection for a human keystroke (#efuuau).
    // Fall back to the tmux paste/send-keys path for loops not under the
    // proxy or if the write fails.
    const sd = process.env[CL_ENV.STATE_DIR];
    // `onWillInject` arms markers (wake-in-flight, last-wake-at,
    // busy-defer tempo) right before the actual socket/tmux write so the
    // UserPromptSubmit hook can read them as soon as claude submits.
    if (onWillInject) {
        try { onWillInject(); } catch { /* swallow — caller hook is best-effort */ }
    }
    if (sd) {
        if (process.platform === "win32") {
            // #281 strategy B: Windows uses a named pipe with raw bytes.
            // It can't be stat'd, so gate on the proxy-alive PID marker
            // instead of existsSync().
            // #974 — proxy alive = l'inject EST le canal ; un échec = bug
            // proxy à investiguer, PAS de fallback tmux (ré-armerait NOT
            // AFK 10m). Fail loud côté caller (return false). Le path tmux
            // plus bas reste la stratégie des loops SANS proxy (proxy absent).
            if (proxyIsAlive(sd)) {
                const pipe = injectPipeName(sd);
                if (await injectViaWinPipe(pipe, phrase)) return true;
                return false;
            }
        } else {
            // Unix wake injection rides the shared loop.sock as a
            // `{kind:"inject"}` ws frame. The timer's server rebroadcasts
            // to the proxy which writes the bytes to its PTY. Two frames
            // (phrase, then `\r`) with a 200ms gap.
            const sock = loopSockPath(sd);
            if (existsSync(sock)) {
                const r = await injectViaLoopSocket(sock, phrase);
                if (r.submitted) return true;
                if (r.phraseSent) {
                    // Phrase made it to the PTY but the Enter frame failed.
                    // DO NOT re-send the phrase via tmux — that double-types.
                    // A stand-alone Enter is the SAME channel (submit), not
                    // a fallback. Submit + return.
                    spawnSync(MUX_CMD, ["send-keys", "-t", paneTarget, "Enter"], { stdio: "ignore" });
                    return true;
                }
                // #974 — loop.sock présent = proxy censé vivant (c'est le
                // process du pane). Inject totalement échoué = bug proxy,
                // PAS de fallback tmux (ré-armerait NOT AFK 10m). Fail loud
                // côté caller.
                return false;
            }
        }
    }
    // Stratégie loops SANS proxy (pas de loop.sock / proxy absent) : tmux
    // paste-buffer + Enter standalone. Path normal documenté pour ces
    // loops, PAS un fallback dégradé (#974).
    const bufName = `wake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const setBuf = spawnSync(MUX_CMD, ["set-buffer", "-b", bufName, phrase], { stdio: "ignore" });
    if (!setBuf.error && setBuf.status === 0) {
        spawnSync(MUX_CMD, ["paste-buffer", "-b", bufName, "-d", "-t", paneTarget], { stdio: "ignore" });
    } else {
        spawnSync(MUX_CMD, ["send-keys", "-t", paneTarget, phrase], { stdio: "ignore" });
    }
    await new Promise<void>((res) => setTimeout(res, 200));
    spawnSync(MUX_CMD, ["send-keys", "-t", paneTarget, "Enter"], { stdio: "ignore" });
    return true;
}

/** #866 Slice 2 — typed enum for the `loop.sock` event kinds. Replace
 *  the bare magic strings (`"view"`, `"proxyEvent"`, etc.) so a typo is
 *  caught at compile time + the surface stays discoverable. */
export const LOOP_SOCK_KIND = {
    VIEW: "view",
    PROXY_EVENT: "proxyEvent",
    INJECT: "inject",
    QUERY_LOOP_STATE: "queryLoopState",
    QUERY_LOOP_STATE_REPLY: "queryLoopStateReply",
    SHUTDOWN: "shutdown",
    GET_SNAPSHOTS: "getSnapshots",
    GET_SNAPSHOTS_REPLY: "getSnapshotsReply",
    /** #944 — out-of-process subprocess (stop-hook, session-start-hook)
     *  ships a single pre-formatted log line to the timer ; the timer
     *  appends it to its stdout (= the unified loop log). Fail-open : the
     *  hook also writes a per-source fallback file if the UDS is down. */
    LOG: "log",
} as const;
export type LoopSockKind = (typeof LOOP_SOCK_KIND)[keyof typeof LOOP_SOCK_KIND];

/**
 * #730 — unified per-loop IPC server bound to `loopSockPath(sd)`. The
 * single `listenEvents` instance handles every frame kind exchanged with
 * the proxy + hooks:
 *
 *  - `LOOP_SOCK_KIND.VIEW`        — timer broadcast → proxy paints the bar
 *  - `LOOP_SOCK_KIND.PROXY_EVENT` — proxy → timer (typing, AFK key, markers, hooks)
 *  - `LOOP_SOCK_KIND.INJECT`      — wake phrase bytes to write to the PTY ;
 *    inbound (from a hook spawned out-of-process) is rebroadcast so the
 *    proxy receives it. The timer's own injects go through `injectText`
 *    which broadcasts directly.
 *  - `LOOP_SOCK_KIND.SHUTDOWN`    — cooperative kill (#866) ; the timer
 *    closes its server + `process.exit(0)`.
 *
 * Direction (#729 inversion): timer = SERVER ; proxy + hooks = CLIENTS.
 */
export interface LoopServer {
    /** Broadcast a view frame to every connected client. No-op if none. */
    pushView(view: import("./loop-state.js").LoopStateView): void;
    /** Broadcast a wake-inject text frame. The proxy writes the bytes
     *  straight to claude's PTY (bypasses tmux send-keys). */
    injectText(text: string): void;
    /** Stop accepting connections + unlink the socket file. Idempotent. */
    close(): void;
}

/** #866 Slice 2 — send a `{kind:"shutdown"}` frame to the timer over
 *  `loop.sock`. Fire-and-forget : the timer reacts by closing its
 *  server + `process.exit(0)`. Returns the void promise without
 *  awaiting reply (the timer exits before any ack would land). Resolves
 *  even when the timer is already dead (= no socket → connection
 *  refused → silent no-op). Used by `cmdReload` / `cmdRm` as a
 *  cooperative kill BEFORE falling back to SIGKILL on the (possibly
 *  wrong) wrapper pid. */
export async function sendShutdownToTimer(sd: string, timeoutMs = 500): Promise<void> {
    const sockPath = loopSockPath(sd);
    try {
        await import("./ipc-events.js").then(m => m.sendEventOnce(sockPath, { kind: LOOP_SOCK_KIND.SHUTDOWN }, { timeoutMs, throwOnError: false }));
    } catch { /* best-effort */ }
}

/** #943 — UDS round-trip to grab the live XState snapshots from the
 *  running timer BEFORE killing it on `cmdReload`. Symmetric to
 *  `selfReloadIfStale` which captures them in-process. Returns the
 *  serialized `RespawnSnapshots` JSON string (suitable to set
 *  directly as `CL_RESPAWN_STATE` env var on the new spawn), or null
 *  on any failure (timer down, socket missing, ws drop, malformed
 *  reply) — caller falls back to a cold-boot new timer (= today's
 *  behavior, AFK reverts to `off`). */
export async function fetchSnapshotsFromTimer(sd: string, timeoutMs = 500): Promise<string | null> {
    const sock = loopSockPath(sd);
    if (!existsSync(sock)) return null;
    const ipcEvents = await import("./ipc-events.js");
    const ch = ipcEvents.openEventChannel(sock, { reconnectMs: 100 });
    try {
        const connected = await new Promise<boolean>((resolve) => {
            const start = Date.now();
            const tick = (): void => {
                if (ch.isConnected()) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                setTimeout(tick, 25);
            };
            tick();
        });
        if (!connected) return null;
        const reply = await ch.request({ kind: LOOP_SOCK_KIND.GET_SNAPSHOTS }, timeoutMs);
        const data = reply.data as { serialized?: string | null } | null | undefined;
        return data?.serialized ?? null;
    } catch {
        return null;
    } finally {
        ch.close();
    }
}

export function createLoopServer(
    sockPath: string,
    handlers: {
        onProxyEvent: (event: Record<string, unknown>) => void;
        /** #866 Slice 2 — invoked when a `LOOP_SOCK_KIND.SHUTDOWN` frame
         *  lands. Defaults to `process.exit(0)` (after `server.close()`).
         *  Tests inject a spy to avoid killing the test process. */
        onShutdownRequest?: () => void;
        /** #943 — called when a `LOOP_SOCK_KIND.GET_SNAPSHOTS` frame
         *  lands ; should return the serialized `RespawnSnapshots` JSON
         *  string (same shape `selfReloadIfStale` builds via
         *  `buildRespawnEnvFromSnapshots`). Null/undefined = nothing to
         *  preserve, the caller's new spawn cold-boots. */
        onGetSnapshots?: () => string | null;
        /** #944 — called when a `LOOP_SOCK_KIND.LOG` frame lands. The hook
         *  subprocess (stop-hook, session-start-hook) ships a single
         *  pre-formatted log line ; the timer appends it to its own log
         *  sink (= stdout, redirected to the unified loop log by the
         *  launcher). Default no-op so non-timer consumers (tests) ignore
         *  the frame silently. */
        onLogLine?: (line: string) => void;
        /** #1039 — a proxy client (re)connected to loop.sock / dropped /
         *  went STALE (heartbeat ping unanswered = IPC confirmed dead). The
         *  loop flags the link state so the BarRenderer paints RED on stale. */
        onClientConnect?: () => void;
        onClientDisconnect?: () => void;
        onClientStale?: () => void;
        /** #1039 — the proxy peer (re)connected / dropped. Keyed on the
         *  connection that sends PROXY_EVENT frames, so hook one-shots that
         *  share loop.sock don't masquerade as the proxy link. */
        onProxyConnect?: () => void;
        onProxyDisconnect?: () => void;
    },
): LoopServer {
    const server: EventServer = listenEvents(sockPath, (ev, { reply, markAsProxy }) => {
        if (ev.kind === LOOP_SOCK_KIND.PROXY_EVENT) {
            // Legacy event shape is wrapped as
            // `{kind:"proxyEvent", data:{event:"...", kind:"...", ...}}`
            // to fit the `Event {kind, data}` shape of ipc-events. The
            // dispatcher expects the legacy object intact — unwrap.
            const inner = ev.data;
            if (!inner || typeof inner !== "object") return;
            // #1039 — tag the connection as THE proxy peer, but ONLY on a
            // proxy-ORIGIN event. The `proxyEvent` kind is ALSO used by the
            // one-shot HOOK connections (`emitHookEventToTimer` → Stop /
            // UserPrompt / SessionStart carry `{event:"hook"}`), which connect
            // and close every turn. Tagging on ANY proxyEvent mistagged those
            // hooks as the proxy → connect+close churn armed a false RED ("la
            // barre rouge alors que tout marche"). The persistent proxy sends
            // hello / keystroke / marker / reload — never `hook` — so excluding
            // `hook` keys the link signal on the real proxy peer.
            if ((inner as { event?: unknown }).event !== "hook") markAsProxy();
            try {
                handlers.onProxyEvent(inner as Record<string, unknown>);
            } catch { /* dispatcher already swallows — defense in depth */ }
            return;
        }
        if (ev.kind === LOOP_SOCK_KIND.INJECT) {
            // Inbound inject from an out-of-process hook (stop-hook,
            // session-start-hook). Rebroadcast so the proxy (which is
            // also a client of this server) receives the bytes and
            // writes them to its PTY. The sender doesn't subscribe to
            // inbound frames so it's a no-op for them.
            const text = typeof (ev.data as { text?: unknown } | null | undefined)?.text === "string"
                ? (ev.data as { text: string }).text
                : null;
            if (text) server.broadcast({ kind: LOOP_SOCK_KIND.INJECT, data: { text } });
            return;
        }
        if (ev.kind === LOOP_SOCK_KIND.QUERY_LOOP_STATE) {
            // #774 — subprocess (cli inspect) asks for a live `ipcState`
            // snapshot. Reply rides the `request/reply` correlation : the
            // client's `__req` id must be echoed in `data` for the channel
            // to route the response back to the awaiting promise. Pull
            // through every field the inspect dump cares about.
            const reqId = (ev.data as { __req?: string } | null | undefined)?.__req;
            const ipc = getIpcState();
            reply({
                kind: LOOP_SOCK_KIND.QUERY_LOOP_STATE_REPLY,
                data: {
                    __req: reqId,
                    paneBusy: ipc.paneBusy ?? false,
                    paneReady: ipc.paneReady ?? false,
                    paneCompacting: ipc.paneCompacting ?? false,
                    paneResuming: ipc.paneResuming ?? false,
                    paneInterrupted: ipc.paneInterrupted ?? false,
                    afkMode: ipc.afkMode,
                    afkExpiryMs: ipc.afkExpiryMs,
                    humanTypingAtMs: ipc.humanTypingAtMs,
                    idleSinceMs: ipc.idleSinceMs,
                    bootComplete: ipc.bootComplete,
                    bootActiveModules: ipc.bootActiveModules,
                    busyDeferUntilMs: ipc.busyDeferUntilMs,
                    lastViewPushAtMs: ipc.lastViewPushAtMs,
                    lastSseEventAtMs: ipc.lastSseEventAtMs,
                    sseConnected: ipc.sseConnected,
                },
            });
            return;
        }
        if (ev.kind === LOOP_SOCK_KIND.GET_SNAPSHOTS) {
            // #943 — `cmdReload` asks for the live XState snapshots
            // BEFORE killing the timer, so the new spawn can restore
            // exact state (AFK wait_inf survives the reload). Reply
            // rides the request/reply correlation : echo `__req` so the
            // client's awaiting promise resolves.
            const reqId = (ev.data as { __req?: string } | null | undefined)?.__req;
            const serialized = handlers.onGetSnapshots ? handlers.onGetSnapshots() : null;
            reply({
                kind: LOOP_SOCK_KIND.GET_SNAPSHOTS_REPLY,
                data: { __req: reqId, serialized },
            });
            return;
        }
        if (ev.kind === LOOP_SOCK_KIND.LOG) {
            // #944 — a hook subprocess shipped a pre-formatted log line.
            // We append it as-is to the timer's own sink so it interleaves
            // chronologically with the timer's ticks in the unified loop
            // log (= `~/.claude-loop/<name>/loop.log` — #966 a unifié le
            // nom file/log post-Slice 4). No format change here ; structured fields land in
            // Slice 2 (NDJSON).
            const line = typeof (ev.data as { line?: unknown } | null | undefined)?.line === "string"
                ? (ev.data as { line: string }).line
                : null;
            if (line && handlers.onLogLine) handlers.onLogLine(line);
            return;
        }
        if (ev.kind === LOOP_SOCK_KIND.SHUTDOWN) {
            // #866 Slice 2 — graceful shutdown request from the parent
            // claude-loop (when it receives SIGTERM/SIGINT/SIGHUP) or
            // from any explicit `claude-loop reload`/`stop`/`rm` flow.
            // The timer closes its loop server, then invokes the
            // injectable `onShutdownRequest` hook (defaults to
            // `process.exit(0)` via nextTick so the reply can flush).
            // The runtime watchdog (#866 Slice 1) is the safety net for
            // cases where this message never lands (parent kill -9,
            // network split, etc.).
            try { server.close(); } catch { /* ignore */ }
            const onShutdown = handlers.onShutdownRequest
                ?? (() => process.exit(0));
            process.nextTick(onShutdown);
            return;
        }
        // Unknown kinds dropped silently — forward-compat.
    }, {
        // #1039 — surface proxy (re)connect / disconnect so the loop can flag
        // the IPC link state (BarRenderer paints RED when down).
        onClientConnect: handlers.onClientConnect,
        onClientDisconnect: handlers.onClientDisconnect,
        onClientStale: handlers.onClientStale,
        onProxyConnect: handlers.onProxyConnect,
        onProxyDisconnect: handlers.onProxyDisconnect,
    });
    return {
        pushView(view) {
            server.broadcast({ kind: LOOP_SOCK_KIND.VIEW, data: view });
        },
        injectText(text) {
            server.broadcast({ kind: LOOP_SOCK_KIND.INJECT, data: { text } });
        },
        close() {
            server.close();
        },
    };
}

/**
 * #281 strategy B (Windows ConPTY) — raw-bytes write to the proxy's
 * named pipe. Mirrors the tmux dance: phrase, a brief pause for the
 * TUI to settle, then a carriage return to submit. Resolves `false`
 * on any error (caller falls back to send-keys) and never throws.
 *
 * Unix uses `injectViaLoopSocket` below (ws over UDS, #730 step 3).
 */
function injectViaWinPipe(pipePath: string, phrase: string): Promise<boolean> {
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
            sock = netConnect(pipePath);
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
 * #730 step 3 — unix wake injection over the shared `loop.sock` ws
 * server. Sends two `{kind:"inject"}` frames (phrase, then `\r`)
 * separated by the TUI-settle delay. The timer's server rebroadcasts
 * each to its other connected clients ; the proxy listens, writes the
 * bytes straight to claude's PTY. Resolves `false` on any failure so
 * the caller falls back to the tmux paste/send-keys path.
 */
async function injectViaLoopSocket(sockPath: string, phrase: string): Promise<{ phraseSent: boolean; submitted: boolean }> {
    let phraseSent = false;
    try {
        await sendEventOnce(sockPath, { kind: "inject", data: { text: phrase } }, { timeoutMs: 2000, throwOnError: true });
        phraseSent = true;
    } catch {
        return { phraseSent: false, submitted: false };
    }
    await new Promise<void>((r) => setTimeout(r, 200));
    try {
        await sendEventOnce(sockPath, { kind: "inject", data: { text: "\r" } }, { timeoutMs: 2000, throwOnError: true });
    } catch {
        return { phraseSent, submitted: false };
    }
    return { phraseSent, submitted: true };
}

/**
 * #965 — envoie des bytes raw directement au PTY de claude via le canal
 * `inject.sock` (folded dans `loop.sock`). Contrairement à
 * `injectWakePhrase`, n'ajoute PAS d'Enter implicite — utilisé par les
 * call-sites qui veulent passer des keystrokes synthétiques (Enter,
 * Down, Escape, …) sans que le proxy les voie comme une frappe humaine
 * via son stdin (cf. pty-proxy.py:14-24 — séparation physique des canaux).
 *
 * Returns true si l'inject a réussi, false sinon (loop.sock absent, proxy
 * pas subscribed, timeout). Le caller décide du fallback (typiquement
 * `tmux send-keys` avec un log de dégradation).
 */
export async function injectRawBytes(sd: string, bytes: string): Promise<boolean> {
    const sock = loopSockPath(sd);
    if (!existsSync(sock)) return false;
    try {
        await sendEventOnce(sock, { kind: "inject", data: { text: bytes } }, { timeoutMs: 2000, throwOnError: true });
        return true;
    } catch {
        return false;
    }
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
     * injecter). #999 — consommé par `pickPhrase` comme fallback du body
     * de l'eventHint quand `fetchWakeContext` n'a pas pu le refetcher.
     * Non persisté dans `lastWakeHintPath` (pas utile pour la coalescence).
     */
    comment_body?: string;
}
