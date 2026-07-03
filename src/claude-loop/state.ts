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
import { homedir } from "node:os";
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
// #969 — rotation : on prune les frames > `CL_PANE_CAPTURE_WINDOW_MIN`
// minutes (default 10) à chaque write. ISO format `YYYY-MM-DDTHH-MM-SS.<ms>Z`
// est string-orderable donc compare-direct sur le nom, pas de stat.
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

const PANE_CAPTURE_LOG_ENABLED = process.env[CL_ENV.PANE_CAPTURE_LOG] === "1";
const PANE_CAPTURE_WINDOW_MIN = (() => {
    const raw = process.env[CL_ENV.PANE_CAPTURE_WINDOW_MIN];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 10;
})();
const PANE_CAPTURE_WINDOW_MS = PANE_CAPTURE_WINDOW_MIN * 60_000;
let lastPaneCaptureWritten: string | null = null; // legacy sink: text-only dedup
// #993 unified-capture dedup : (text + cursor). A cursor-only move IS a new
// frame (it's what tells real input from a ghost suggestion). `lastCaptureText`
// + `lastPaneFile` let a cursor-only move reuse the previous .txt (no dup file).
let lastCaptureKey: string | null = null;
let lastCaptureText: string | null = null;
let lastPaneFile: string | null = null;
let captureSeq = 0; // tie-breaker so two frames in the same ms don't collide

export function prunePaneCaptures(dir: string, cutoffMs: number): void {
    const cutoffIso = new Date(cutoffMs).toISOString().replace(/:/g, "-");
    try {
        for (const f of readdirSync(dir)) {
            if (f.endsWith(".txt") && f < cutoffIso) {
                try { unlinkSync(join(dir, f)); } catch { /* skip */ }
            }
        }
    } catch { /* dir gone */ }
}

export function logPaneCapture(sd: string | undefined, text: string, cursor?: { x: number; y: number } | null): void {
    if (!sd) return;
    if (!PANE_CAPTURE_LOG_ENABLED && !CAPTURE_ENABLED) return;
    const nowMs = Date.now();
    // #990/#993 unified capture — write a timeline row when the text OR the
    // cursor changed. The frame is dumped as `panes/<ms>.txt` and the row
    // references it by short path (david `684qhp`) + records the cursor
    // (cursorX/cursorY) so a replay can tell real input from a ghost
    // suggestion. A cursor-only move reuses the previous .txt (no dup file).
    if (CAPTURE_ENABLED) {
        const key = `${text} ${cursor ? `${cursor.x},${cursor.y}` : ""}`;
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
    // #678/#969 legacy per-file rotated dump — deprecated alias, text-only dedup.
    if (PANE_CAPTURE_LOG_ENABLED && text !== lastPaneCaptureWritten) {
        try {
            const dir = paneCaptureDir(sd);
            mkdirSync(dir, { recursive: true });
            const iso = new Date(nowMs).toISOString().replace(/:/g, "-");
            writeFileSync(join(dir, `${iso}.txt`), text);
            prunePaneCaptures(dir, nowMs - PANE_CAPTURE_WINDOW_MS);
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
        const [pingsR, projects, unreadR, consumerR] = await Promise.all([
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
            (client.unread(null, 1) as Promise<{
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
                }>;
            }>).catch(() => ({ messages: [] })),
            // #397: this loop's own consumer row → its micro_prompt, exposed as
            // the `{consumer_prompt}` placeholder. Best-effort (null on failure).
            client.getConsumer(client.agentId).catch(() => null) as Promise<{ micro_prompt?: string | null } | null>,
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
        // Drop empty comments without a pending decision. The FIFO head
        // must carry actionable content (body, or a pending decision
        // proposal); otherwise treat as missing so the wake falls
        // through to the idle branch instead of emitting "(#X / #Y)".
        if (unreadHead && unreadHead.kind === "comment_added") {
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
        const DECISION_EVENT_VERBS: Record<string, string> = {
            plan_accepted: "Your plan was ACCEPTED — execute",
            plan_rejected: "REJECT — your plan, ball back in your court",
            resolution_accepted: "Your resolution was ACCEPTED, ticket closed",
            resolution_rejected: "REJECT — your resolution, ticket stays open",
            wontfix_accepted: "Your wontfix was ACCEPTED, ticket closed",
            wontfix_rejected: "REJECT — your wontfix, ticket stays open",
            escalation_accepted: "Your escalation was ACCEPTED",
            escalation_rejected: "REJECT — your escalation",
        };
        const unreadKind = unreadHead?.kind ?? "";
        // #1163 S2 — digest des decision-events : quand la TÊTE du FIFO est un
        // event décisionnel ET que les messages non-vus suivants le sont
        // aussi (le run de tête), on les livre EN UN SEUL wake au lieu d'un
        // tour par accept (« 5 resolution ACCEPTED = 5 tours », REX runic).
        // Les events restent unitaires en DB ; seule la LIVRAISON groupe.
        // Les comments/tickets (qui demandent une action) restent unitaires.
        const DIGEST_LABELS: Record<string, string> = {
            plan_accepted: "plan ACCEPTED",
            plan_rejected: "plan REJECT",
            resolution_accepted: "resolution ACCEPTED",
            resolution_rejected: "resolution REJECT",
            wontfix_accepted: "wontfix ACCEPTED",
            wontfix_rejected: "wontfix REJECT",
            escalation_accepted: "escalation ACCEPTED",
            escalation_rejected: "escalation REJECT",
        };
        const unreadMsgs = Array.isArray(unreadR?.messages) ? unreadR.messages : [];
        const decisionRun: typeof unreadMsgs = [];
        for (const m of unreadMsgs) {
            if (m?.kind && DIGEST_LABELS[m.kind]) decisionRun.push(m);
            else break;
        }
        let headDecisionDigest = "";
        let digestExtraSeenIds: number[] = [];
        if (decisionRun.length >= 2) {
            const deciders = new Set(decisionRun.map((m) => m.by_agent ?? ""));
            const by = deciders.size === 1 ? ` — by ${[...deciders][0]}` : "";
            const parts = decisionRun.map((m) =>
                `${DIGEST_LABELS[m.kind!]} #${m.kind === "ticket_created" ? m.id : (m.ticket_id ?? m.id)}`);
            headDecisionDigest = `${decisionRun.length} decisions${by}: ${parts.join(" · ")}`;
            digestExtraSeenIds = decisionRun.slice(1).map((m) => m.id).filter((v): v is number => typeof v === "number");
        }
        if (unreadKind && LIFECYCLE_VERBS[unreadKind]) {
            headLifecycleVerb = LIFECYCLE_VERBS[unreadKind];
        }
        // Resolve the decision-event phrase + decider when the unread
        // head is one of the 8 new kinds. Empty string when not.
        let headDecisionEvent = "";
        let headDecisionDecider = "";
        let headDecisionRefHashid = "";
        if (unreadKind && DECISION_EVENT_VERBS[unreadKind] && !headDecisionDigest) {
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
            if (!isTicketRoot && !isLifecycle && !isDecisionEvent && typeof unreadHead.hashid === "string") {
                headCommentHashid = unreadHead.hashid;
            }
            if (!isTicketRoot && !isLifecycle && !isDecisionEvent && typeof unreadHead.body === "string" && unreadHead.body) {
                headBody = stripMarkdown(unreadHead.body);
            }
            // Title lookup for comment heads (the unread row doesn't carry
            // the parent ticket's title). Best-effort getTicket.
            if (!head.title && !isTicketRoot) {
                try {
                    const t = await client.getTicket(head.id, { summary: true }) as {
                        ticket?: { title?: string | null };
                    };
                    const title = t.ticket?.title;
                    if (typeof title === "string" && title) head = { ...head, title };
                } catch { /* best-effort */ }
            } else if (isTicketRoot && !head.title && unreadHead.title) {
                head = { ...head, title: unreadHead.title };
            }
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
        // branche decision-event rend « Your resolution was ACCEPTED »).
        const hintIsComment = eventHint?.commentKind
            ? (!DECISION_EVENT_VERBS[eventHint.commentKind] && !LIFECYCLE_VERBS[eventHint.commentKind]
                && eventHint.commentKind !== "ticket_created")
            : true; // kind inconnu (hint legacy) : comportement inchangé
        if (eventHint?.commentHashid && hintIsComment
            && !headCommentHashid && !headLifecycleVerb && !headDecisionEvent
            && head?.kind !== "new ticket") {
            headCommentHashid = eventHint.commentHashid;
            if (eventHint.commentBody) headBody = eventHint.commentBody;
            if (!head?.id) {
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
                const raw = await client.listTickets({
                    ...(project ? { project } : {}),
                    backlog: "1",
                    limit: "10",
                    cooldown_sec: cooldownSec > 0 ? String(cooldownSec) : undefined,
                });
                const rows = Array.isArray(raw)
                    ? (raw as Array<{ id: number; title?: string | null; backlog_cooled_until?: string | null }>)
                    : ((raw as { tickets?: Array<{ id: number; title?: string | null; backlog_cooled_until?: string | null }>; rows?: Array<{ id: number; title?: string | null; backlog_cooled_until?: string | null }> })?.tickets
                        ?? (raw as { rows?: Array<{ id: number; title?: string | null; backlog_cooled_until?: string | null }> })?.rows
                        ?? []);
                const top = rows.find((r) => !r.backlog_cooled_until);
                if (top && Number.isFinite(top.id)) {
                    head = { id: top.id, title: top.title ?? undefined, kind: undefined };
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
            no_head: (!headCommentHashid && head?.kind !== "new ticket" && !headLifecycleVerb && !headDecisionEvent && !headDecisionDigest && !backlogMode) ? "1" : "",
            backlog_mode: backlogMode,
            head_comment_hashid: headCommentHashid,
            head_body: headBody,
            // #830 — decision event branch vars. head_decision_event is the
            // pre-formatted phrase ("Your plan was ACCEPTED" etc.) ; the
            // wake template wraps it with the ticket ref + decider + the
            // original proposal hashid for navigation.
            head_decision_event: headDecisionEvent,
            // #1163 S2 — pré-formaté comme head_decision_event ; branche
            // mutuellement exclusive (le single est éteint quand le digest fire).
            head_decision_digest: headDecisionDigest,
            head_decision_decider: headDecisionDecider,
            head_decision_ref_hashid: headDecisionRefHashid,
            project_scope: scope,
            // #1158 (a) — timestamp du CTA backlog : un pointeur d'état peut
            // périmer dans la file d'input (pilotage concurrent) ; dater le
            // CTA rend le skip d'un wake périmé trivial côté agent.
            state_time: new Date().toTimeString().slice(0, 5),
            // #397: {consumer_prompt} = this consumer's micro-prompt (opt-in;
            // empty → renders to nothing). David puts the placeholder in his
            // wake_master override where he wants it.
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
            "{head_comment_hashid:+{head_body:+{head_body} }(#{head_id} / #{head_comment_hashid})}"
            + "{head_kind:+new ticket #{head_id}{head_title:+: {head_title}}}"
            + "{head_lifecycle:+#{head_id} {head_lifecycle}{head_title:+: {head_title}}}"
            + "{head_decision_event:+{head_decision_event} on #{head_id}{head_title:+: {head_title}}{head_decision_decider:+ by {head_decision_decider}}{head_decision_ref_hashid:+ (#{head_decision_ref_hashid})}}"
            + "{head_decision_digest:+{head_decision_digest}}"
            + "{backlog_mode:+{culture} look #{head_id}{head_title:+: {head_title}}. Triage the ticket.{state_time:+ (state {state_time})}}";
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
            || head?.kind === "new ticket" || backlogMode);
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
        const headMessageId = unreadHead?.id ?? null;
        // hasContent flags whether one of the actionable branches fired
        // (FIFO comment, lifecycle, new ticket, or backlog). When false
        // the phrase is just the idle culture+lead — drain-style wake
        // reasons skip on it.
        const hasContent = !!(headCommentHashid || headLifecycleVerb || headDecisionEvent || headDecisionDigest || head?.kind === "new ticket" || backlogMode);
        // #786 — surface the backlog-branch ticket id so the inject site
        // can start the per-consumer cooldown clock. Only when the
        // backlog branch actually fired (not on FIFO / lifecycle).
        const backlogTicketId = (backlogMode && head?.id) ? head.id : null;
        if (gateResults.length === 0) return { phrase: cta, headMessageId, hasContent, backlogTicketId, extraSeenIds: digestExtraSeenIds };
        const banner = gateResults
            .map((g) => (g.slot ? renderSlot(promptMap, g.slot, g.vars, g.message, tone) : g.message))
            .join("  ");
        return {
            phrase: `${blocking ? "🛑 " : ""}${banner}  ${cta}`,
            headMessageId,
            // A triggered gate counts as content even if the FIFO is empty.
            hasContent: hasContent || gateResults.length > 0,
            backlogTicketId,
            extraSeenIds: digestExtraSeenIds,
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
