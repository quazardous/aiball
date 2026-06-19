#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop timer process (#B.63 TS port, #B.148 phase C reactive).
 *
 * Detached child of the `start` command. Two operating modes:
 *
 *   - **SSE mode** (when CL_CHECK_CMD is the default aiball check):
 *     opens a long-lived SSE stream to the daemon's `/api/events`
 *     endpoint and wakes claude as soon as a `ping` event arrives. No
 *     polling lag. A slow heartbeat (every CL_INTERVAL) checks
 *     `wake-requested` and re-verifies in case SSE silently dropped.
 *
 *   - **Polling mode** (custom CL_CHECK_CMD or when SSE refuses to
 *     start): legacy `while(sleep, check)` loop — exact behavior
 *     pre-#B.148.
 *
 * Both modes share `tryWake()` which honors idle-since + user-grace +
 * tmux-alive gates, fires send-keys, and updates the tmux status bar.
 *
 * Logs to stdout (the launcher redirects to $STATE_DIR/loop.log).
 * Exits when the tmux session disappears.
 *
 * PRIMARY TODO (#B.178 win) — generic stuck-at-menu detection:
 * claude's interactive first-run gates (MCP-trust [1/2/3], theme
 * picker, "update available", trust-folder, expired login, resume
 * picker, …) block boot in a detached session — nobody is attached to
 * answer, so claude never reaches its prompt and the loop looks dead.
 * This timer already capture-pane's every tick, so it's the right
 * place to: after boot-grace, detect that claude is NOT at its ready
 * prompt, capture the offending screen, surface it (log + ping the
 * human via aiball), and optionally send a conservative key. That
 * generalizes to menus that don't exist yet — the durable fix vs
 * per-menu settings flags. Interim: user runs `claude` once to clear
 * the one-time gates (see docs/WIN-INSTALL.md).
 */
import { appendFileSync, existsSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import { createLogger } from "../log.js";
import { drainOffload, listOffloadComponents } from "./offload.js";
import {
    armBusyDefer,
    WAKE_COALESCE_WINDOW_MS,
    isInternalCheckCmd,
    createLoopServer,
    loopSockPath,
    readLoopStateInput,
    setCompacting,
    setInterrupted,
    setPaneBusy,
    setPaneReady,
    setResumeModePicker,
    setResumeSessionPicker,
    setResuming,
    MUX_CMD,
    buildContextPhrase,
    injectWakePhrase,
    checkHasWork,
    readIdleSinceMs,
    humanPresentHold,
    humanIsTyping,
    installRoot,
    installRootSha,
    STATE_ROOT,
    isLoopStale,
    pingsPath,
    readBusyDefer,
    recordOpenWakeHash,
    readDrainedState,
    touchHumanTyping,
    writeDrainedState,
    tmuxName,
    humanPresence,
    injectRawBytes,
    logBarPaint,
    logPaneCapture,
    zenPath,
    readPlate,
    writePlate,
    envPath,
    loopLogPath,
    loopPidPath,
    type Plate,
    type WakeHint,
    type WakeEventHint,
} from "./state.js";
import { parseDrainedStrategy, decideDrainedWake } from "./drained-strategy.js";
import { loopConfig } from "./loop-config.js";
import { armErrorBackoff, readErrorBackoff, resetErrorBackoff } from "./error-backoff.js";
import { syncPaneServiceFromMarkers } from "./pane-service-sync.js";
import { paneMarkerBarInfo } from "./pane-service.js";
import { getCompactingDetector } from "./compacting-detector.js";
import { PaneObserver } from "./pane-watchers/observer.js";
import { Zone } from "./pane-watchers/zone.js";
import {
    PickerSessionWatcher,
    PickerModeWatcher,
    ResumingWatcher,
    CompactConfirmWatcher,
} from "./pane-watchers/boot-watchers.js";
import { PromptWatcher, BusyWatcher, InterruptedWatcher, IdlePromptWatcher } from "./pane-watchers/runtime-watchers.js";
import { HealthCheckWatcher } from "./pane-watchers/health-check-watcher.js";
import { PromptZoneWatcher, PromptInputWatcher } from "./pane-watchers/prompt-zone-watcher.js";
import { getHealthCheckService } from "./health-check-service.js";
import { ErrorWatcher } from "./pane-watchers/error-watcher.js";
import { armAfkViaService } from "./afk-service-sync.js";
import { getAfkService } from "./afk-service.js";
import { getWakeService } from "./wake-service.js";
import { getTypingService } from "./typing-service.js";
import { getTurnService } from "./turn-service.js";
import { probeParentTmuxAtBoot, installParentTmuxWatchdog, sweepSiblingTimers } from "./parent-liveness.js";
import {
    buildRespawnEnvFromSnapshots,
    consumePendingSnapshot,
    parseRespawnSnapshots,
    RESPAWN_STATE_ENV_VAR,
    serializeRespawnSnapshots,
    setPendingRespawnSnapshots,
} from "./respawn-state.js";
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { bootMachine, liveBootModules } from "./boot-machine.js";

let bootActor: ActorRefFrom<typeof bootMachine> | null = null;
import { getHookWatcher } from "./hook-watcher.js";
import { getSanityService } from "./sanity-service.js";
import {
    getIpcState,
    onIpcChanged,
    setIpcBusyDeferUntil,
    setIpcAfk,
    setIpcDispAfk,
    setIpcBootComplete,
    setIpcLoopStart,
    setIpcHumanTypingAtMs,
    setIpcHealthPromptVisible,
    setIpcPromptZoneVisible,
    setIpcPromptHasInput,
    setIpcBootDeadlineMs,
    setIpcBootActiveModules,
    setIpcCounters,
    setIpcIdleSince,
    setIpcNextWakeAt,
    setIpcLastSseEventAtMs,
    setIpcSseConnected,
    setIpcLinkDown,
    setIpcLastWakeAtMs,
    setIpcResumeModePicker,
    setIpcLastViewPushAtMs,
    setIpcStateTagInfo,
    setIpcResumeSessionPicker,
    setIpcWakeInFlightAtMs,
    setIpcWakeRequested,
} from "./ipc-state.js";
import { computeLoopView, isHumanPresentHold, isInputHot, shouldInjectBootstrapSkill, deriveBarCounters, LoopStateBus } from "./loop-state.js";
import {
    seenProof,
    isBusy as busyStackActive,
    releaseAll as releaseBusyProofs,
    PROOF_TURN,
    PROOF_ESC,
    PROOF_COMPACTING,
    type BusyProofs,
} from "./busy-stack.js";
import { BarRenderer } from "./bar-renderer.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";
import { WakeBus } from "./wake-bus.js";
import { CL_ENV } from "./env-vars.js";
import { stripMarkdown } from "./markdown-strip.js";
import { loadPromptsFromYaml, mergePrompts, renderSlot } from "../prompt-templates.js";

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
// #393: the loop's root (stable for its lifetime) — pushed with each state
// heartbeat so the daemon can mark the project "local". Read once from the plate.
const loopCwd = (() => { try { return sd ? readPlate(sd).cwd : undefined; } catch { return undefined; } })();
// #393 (Option A): the loop's project (from the env the loop exports) — pushed
// with each heartbeat so the daemon attributes the root to EXACTLY this project.
const loopProject = process.env.AIBALL_PROJECT || undefined;
const cfg = loopConfig().claude_loop;
const checkCmd = process.env[CL_ENV.CHECK_CMD] ?? "true";
// #619 collapse (david `e54hx2`) — the historical 2-window distinction
// (user-grace 60s for wakes vs ask-grace 600s for AskUserQuestion) was
// retired. A single grace window now drives both gates. To stay
// back-compat with projects that still set `ask_grace_seconds` in
if (!sd || !name) {
    process.stderr.write("[claude-loop:timer] missing CL_* env vars\n");
    process.exit(1);
}
const interval = Math.max(1, cfg.interval_seconds);
// #999 — propagate the configured drain tempo to the env so `turn-service`
// (which reads `CL_WAKE_TEMPO_SEC` lazily at first `getTurnService()`) picks
// up the `.aiball.yaml` value. Must run before any `getTurnService()` call.
const wakeTempoSec = Math.max(1, cfg.wake_tempo_seconds);
process.env[CL_ENV.WAKE_TEMPO_SEC] = String(wakeTempoSec);
const tname = tmuxName(name);

/**
 * #442: CLEAN SHUTDOWN — the canonical "stop this loop" path. Triggered by
 * `SIGTERM` (the signal mirror of `claude-loop stop`, completing the convention
 * HUP=restart / USR2=reload / TERM=stop) AND by a remote `control:kill` over the
 * SSE the loop already holds — both converge here. Kills the tmux session
 * (claude + pane die), then exits THIS (detached) timer process.
 *
 * We deliberately do NOT reuse `cmdRm`: it `process.kill()`s the RECORDED timer
 * pid, and only an explicit in-process exit reliably stops the live timer (cf.
 * #413). The exit closes the SSE → the daemon broadcasts `running:false`
 * (live-presence) so the UI clears the badge without polling.
 *
 * (B) A *stop* HALTS but LEAVES the state dir — the loop shows as dead in
 * `claude-loop list` and stays `restart`/`prune`-able. `claude-loop rm` is the
 * halt + delete.
 */
function cleanShutdown(reason: string): void {
    log(`clean shutdown (${reason}) — stopping loop '${name}' (transient state swept; rm to delete)`);
    try { spawnSync(MUX_CMD, ["kill-session", "-t", tname], { stdio: "ignore" }); } catch { /* tmux already gone */ }
    // #442 sweep — drop the transient RUNTIME markers (stale `loop.pid`,
    // `idle-since`, `wake-*`, `human-typing`, `busy-defer-until`,
    // `inject.sock`, …) so the dead loop reads cleanly in `claude-loop list` and a
    // later signal can't chase a recycled pid. KEEP the durable start config +
    // history (plate/env/pings/loop.log) so `restart` replays. (B): the state dir
    // itself stays — `rm` is the halt + delete.
    if (sd) {
        const KEEP = new Set(["plate.json", "env", "pings.yaml", "loop.log"]);
        try {
            for (const f of readdirSync(sd)) {
                if (KEEP.has(f)) continue;
                try { unlinkSync(join(sd, f)); } catch { /* a subdir or a race — skip */ }
            }
        } catch { /* state dir already gone */ }
    }
    process.exit(0);
}

// #413: le timer enregistre SON PROPRE pid ici, en écrasant le pid-wrapper
// deviné par cmdStart / cmdReload / selfReloadIfStale (= le child.pid de
// `bash -lc "… exec tsx …"`). tsx 4.21 exécute ce script dans un process ENFANT
// forké : ce pid-wrapper est donc le bash→tsx (qui exit → devient un zombie
// defunct), PAS ce process — celui qui porte les handlers SIGHUP/SIGUSR2. Sans
// ça, `kill -HUP`/`-USR2`, `claude-loop reload` et `restart` signalent le mauvais
// pid → no-op silencieux (cf. le "kill -1 ne fait rien" de david).
// #966 — boot-time migration : si l'ancien state-dir vivant porte
// `timer.log` / `timer.pid`, rename vers les nouveaux noms avant tout
// write. Idempotent : ne fait rien si le nouveau existe déjà.
if (sd) {
    for (const [from, to] of [["timer.pid", "loop.pid"], ["timer.log", "loop.log"]] as const) {
        const oldPath = join(sd, from);
        const newPath = join(sd, to);
        if (existsSync(oldPath) && !existsSync(newPath)) {
            try { renameSync(oldPath, newPath); } catch { /* best effort */ }
        }
    }
}
try { writeFileSync(loopPidPath(sd!), `${process.pid}\n`); } catch { /* best effort — la cible kill resterait le wrapper */ }

// #302: --no-wait (CL_WAIT=0) assumes NO human at the terminal → eager boot
// drain, no boot-grace deferral. Default (--wait): during the first
// CL_BOOT_GRACE_SEC after launch, tryWake holds off ALL auto-wakes so the
// human has the take-over window — only `boot-settle` (grace-aware) fires at
// the end of the window. Fixes #302 (auto-ping firing at startup while the
// bar shows `wait`).
// #629 david `y43etd` : NO_WAIT removed — the only place it gated
// was `shouldArmAfk10mOnSettleBoot`, which is gone (user-grace already
// silently gates wakes if user typed during boot). Kept the env var
// `CL_WAIT` shape ; readers in the proxy still honor it.
// #868 david `<chat>` : `BOOT_GRACE_MS` (= safety cap qui driveait settleBoot)
// retiré. Le BootMachine acteur (cf. boot-machine.ts) est désormais l'unique
// autorité du sealing : la deadline push (WATCHER_TICK) absorbe le post-tail
// grace, et le `DEADLINE_REACHED` self-fire scelle. Watchers (paneReady /
// resumePicker / paneCompacting) stretch la deadline tant qu'une condition
// "still booting" reste vraie.
// #872 Phase 3 — `BOOT_GRACE_TAIL_MS` retiré (replaced by the deadline push
// semantics du BootMachine acteur). Cf. boot-machine.ts.
// #627 — BOOT_TIME used to feed the inline boot-grace if/else trees ;
// the LoopState service now reads `loop-start-ts` from the state-dir
// (shared marker, same as the hooks). Kept the constant declaration
// noted here for grep history.

// #412: timer log routed through the level logger (tag `claude-loop:<name>`,
// stdout → redirected to loop.log by the launcher). Existing calls map to
// `info` so default output is unchanged (now carrying the LEVEL token); use
// `logger.debug(…)` for new diagnostic lines (dropped at the default `info`).
// #B.198: ts stays at the head so `--log` can reorder as `<ts> [tag] body`.
const logger = createLogger({ tag: `claude-loop:${name}` });
function log(msg: string): void {
    logger.info(msg);
}
// #1032 S2 — drain every component's offload buffer into the central log,
// each entry replayed with its ORIGINAL ts (→ unified timeline), then cleared.
// Called at boot : the timer has just (re)started, so anything the hooks/proxy
// offloaded while it was down (IPC unreachable) is replayed now. Best-effort.
function drainOffloadIntoLog(): void {
    if (!sd) return;
    for (const component of listOffloadComponents(sd)) {
        const entries = drainOffload(sd, component);
        for (const e of entries) {
            logger.replay(e.ts, "info", `[offload ${e.component}/${e.kind}]${e.msg ? ` ${e.msg}` : ""}`);
        }
        if (entries.length) log(`drained ${entries.length} offload entr${entries.length === 1 ? "y" : "ies"} from '${component}' into the log`);
    }
}

// #963 — log every module evaluation (= every tsx-watch re-import OR
// fresh boot). Silencieux avant : on voyait le self-reload basé sur git
// sha (`source moved since boot…`) mais PAS le hot-reload tsx-watch.
// Trou de visibilité comblé : si tu vois 3 lignes en 10s, tsx-watch a
// tournoyé. Le sha permet de distinguer un hot-reload pur (sha
// inchangé) d'un git checkout (sha bouge).
log(`loop.ts module boot — pid=${process.pid} sha=${installRootSha()}`);

/**
 * Transient-tolerant tmux session check. Distinguishes between:
 *   - `r.error` set : spawn failed entirely (binary missing/locked/etc.) —
 *     treated as transient, returns `true` (assume alive) up to
 *     SPAWN_RETRY_LIMIT consecutive times; only then declared dead.
 *   - `r.status === 0` : session exists.
 *   - `r.status !== 0` (no spawn error) : binary ran and reported no such
 *     session — genuine teardown, exit immediately.
 *
 * Motivation: a transient `has-session` spawn failure (mux binary swap
 * during an upgrade — Windows rename + replace, Linux package upgrade,
 * brief PATH glitch) used to instantly exit the timer loop, which then
 * dropped the SSE presence signal even though the tmux session and the
 * loop's claude were still very much alive. Portable across platforms
 * (the spawnSync.error mechanism is identical on Linux + Windows).
 */
const SPAWN_RETRY_LIMIT = 5;
let consecutiveSpawnErr = 0;
function tmuxAlive(): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tname], { stdio: "ignore" });
    if (r.error) {
        consecutiveSpawnErr++;
        if (consecutiveSpawnErr <= SPAWN_RETRY_LIMIT) {
            log(`tmux probe spawn error (${r.error.message}, streak ${consecutiveSpawnErr}/${SPAWN_RETRY_LIMIT}) — treating session as alive`);
            return true;
        }
        log(`tmux probe spawn error persisting (${SPAWN_RETRY_LIMIT}× in a row) — declaring session gone`);
        return false;
    }
    consecutiveSpawnErr = 0;
    return r.status === 0;
}

// #859 plan B — early parent-liveness probe. Couvre la race
// `selfReloadIfStale` : OLD timer spawn un NEW detached child + exit,
// pendant la fenêtre de boot du NEW (~1-2s) la tmux session peut déjà
// être morte (claude exit, bash trap fired, kill-session vide). Sans
// ce check, le NEW timer reste vivant jusqu'à ce que le watchdog
// main-loop s'arme (ligne ~1086) et tape sa 1ère probe — soit 2-5s
// supplémentaires d'orphelin. Probe AVANT d'armer quoi que ce soit.
// Logique pure dans `parent-liveness.ts` pour qu'on puisse la tester.
if (probeParentTmuxAtBoot(MUX_CMD, tname)) {
    log(`startup: tmux session '${tname}' already gone — exit immediately (orphan-prevent)`);
    // No cleanShutdown : functions below not defined yet ; the prior
    // timer already swept on its way out.
    process.exit(0);
}

// #866 Slice 4 — sweep des sibling timer.ts processes bound au même
// CL_STATE_DIR. Catches les vieux fantômes (pre-#866 sans watchdog,
// timers échappés à cmdReload+sweepOrphans, selfReload coincé). Sans
// ça plusieurs timers paint la bar en race + ipcState diverge.
// AVANT le bind loop.sock (sinon le fantôme garde le socket → EADDRINUSE).
if (sd) {
    const sweep = sweepSiblingTimers(sd);
    // #916 — log toujours, pas seulement quand kill : pour diag du bug
    // où la sweep tape pty-proxy/claude au lieu de sibling timer.
    log(`startup: sweep marker=CL_STATE_DIR=${sd} scanned=${sweep.scanned} matched=${sweep.matched.length} killed=${sweep.killed.length}`);
    for (const m of sweep.matched) {
        log(`  sweep matched pid=${m.pid} cmdline=${m.cmdline}`);
    }
}

// #868 — respawn handoff via env var `CL_RESPAWN_STATE` (JSON-serialized
// whitelist : seul l'état qui ne se re-dérive pas des watchers
// transite). David `h5sgdx` principe SM persistente : bootComplete
// (boot phase a déjà été sealed), afkMode + afkExpiryMs (le countdown
// NOT AFK 10m a un expiry absolu). Le reste (pane*/idleSince/AFK
// dispAfk) re-dérive du pane watcher + bus events en quelques secondes.
//
// Cross-process via env (`spawn({env})` côté old, `process.env.X` côté
// new). Ephemère : meurt avec le process, pas de cleanup à gérer.
if (sd) {
    // #884 — respawn handoff via XState v5 snapshots (seul format
    // supporté depuis le drop du fallback legacy whitelist `Go D`).
    const snapshots = parseRespawnSnapshots(process.env[RESPAWN_STATE_ENV_VAR]);
    if (snapshots) {
        setPendingRespawnSnapshots(snapshots);
        // Si le snapshot boot était `sealed` (= boot phase déjà terminé
        // dans l'old process), bypass le bootMin floor en re-stampant
        // loop-start-ts dans le passé.
        const bootSnap = snapshots.boot as { value?: unknown } | undefined;
        const bootWasSealed = bootSnap && typeof bootSnap.value === "object"
            && bootSnap.value !== null && "sealed" in bootSnap.value;
        if (bootWasSealed || (bootSnap && bootSnap.value === "sealed")) {
            setIpcBootComplete(true);
            try {
                const fakeStart = Date.now() - (Number(process.env.CL_BOOT_MIN_SEC ?? 30) * 1000 + 1000);
                writeFileSync(join(sd, "loop-start-ts"), String(fakeStart));
            } catch { /* best-effort */ }
        }
        log(`respawn handoff: consumed snapshots (${Object.keys(snapshots).filter((k) => snapshots[k as keyof typeof snapshots] !== undefined).join(", ")})`);
    }
}

/**
 * Read the visible content of pane 0. Empty string on any failure
 * (tmux gone, capture errored) — callers fall back to last-known
 * state. Used by the heartbeat `esc to interrupt` probe (#B.173).
 */
// #993 — last cursor probed alongside the most recent capturePane(), reused by
// refreshPaneMarkers for the watcher tick (avoids a 2nd display-message call)
// and recorded into the capture by logPaneCapture.
let lastCursor: { x: number; y: number } | null = null;

function capturePane(): string {
    try {
        const r = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tname}.0`, "-p",
        ], { encoding: "utf8" });
        const text = r.stdout ?? "";
        lastCursor = captureCursor();
        logPaneCapture(sd, text, lastCursor);
        return text;
    } catch {
        return "";
    }
}

// #993 — tmux pane cursor (0-based, visible-screen relative). Needed to tell
// real typed input apart from Claude's greyed ghost-suggestions in the prompt
// box (typed text is left of the cursor, suggestion right). null on any error
// → watchers fall back to text-only detection.
function captureCursor(): { x: number; y: number } | null {
    try {
        const r = spawnSync(MUX_CMD, [
            "display-message", "-p", "-t", `${tname}.0`, "-F", "#{cursor_x} #{cursor_y}",
        ], { encoding: "utf8" });
        const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(\d+)$/);
        return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    } catch {
        return null;
    }
}

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * #251: self-reload on stale source. Called from the heartbeat ONLY when
 * claude is idle with nothing to wake on — the safe lull david asked for
 * ("il faut le faire que quand claude-loop passe en idle, cad rien à
 * faire"). If the install root's git SHA has moved since this timer
 * booted, re-exec a fresh timer in place: the tmux session + claude pane
 * are untouched (the conversation survives), only the long-lived timer
 * process — which holds stale code in memory since tsx doesn't hot-reload
 * (#B.198) — is recycled.
 *
 * Re-stamps `plate.started_at_sha` to the current HEAD BEFORE respawning
 * so the fresh timer boots in-sync and doesn't immediately reload again.
 * That restamp is also the natural debounce against a burst of commits:
 * each reload jumps straight to the latest SHA. No-ops on non-git installs
 * (`isLoopStale` is false when `installRootSha` can't resolve), leaving
 * binary deployments on manual `claude-loop reload`.
 *
 * Does not return when it reloads — the process exits after handing off.
 */
function selfReloadIfStale(): void {
    let plate: Plate;
    try { plate = readPlate(sd!); } catch { return; }
    if (!isLoopStale(plate)) return;
    const sha = installRootSha();
    log(
        `source moved since boot (${(plate.started_at_sha ?? "?").slice(0, 7)} → ${(sha ?? "?").slice(0, 7)}) ` +
        `and loop is idle — self-reloading timer`,
    );
    respawnTimer("SHA moved since boot (idle)");
}

// #1040 — on-demand timer re-exec, extracted from `selfReloadIfStale` so the
// Ctrl+F9 reload hotkey (and the SHA-stale auto-trigger) share ONE re-exec
// path. Captures the XState snapshots, stamps the current SHA on the plate (so
// the fresh timer doesn't immediately self-reload again), spawns a detached
// new timer on the SAME entrypoint (loop.ts), and exits. The hotkey path
// BYPASSES the SHA staleness check (= a manual reload regardless of drift) —
// useful precisely when the auto-trigger is broken (#1040).
function respawnTimer(reason: string): void {
    log(`respawning timer — ${reason}`);
    try {
        const plate = readPlate(sd!);
        const sha = installRootSha();
        if (sha) { plate.started_at_sha = sha; try { writePlate(sd!, plate); } catch { /* best effort */ } }
    } catch { /* no plate — proceed with the respawn anyway */ }
    // #884 — capture les snapshots XState v5 des 5 controllers AVANT de
    // spawn le new process. Le NEW timer les restaure via
    // `setPendingRespawnSnapshots` au boot puis les service factories
    // les consomment. Pattern uniforme, drop les sync ad hoc HARD_*.
    const respawnEnv = buildRespawnEnvFromSnapshots({
        boot: bootActor ? bootActor.getPersistedSnapshot() : undefined,
        afk: getAfkService().getActor().getPersistedSnapshot(),
        wake: getWakeService().getActor().getPersistedSnapshot(),
        typing: getTypingService().getActor().getPersistedSnapshot(),
        idle: getTurnService().getActor().getPersistedSnapshot(),
    });
    const root = installRoot();
    const logFd = openSync(loopLogPath(sd!), "a");
    // Entrypoint is loop.ts (NOT timer.ts — that file doesn't exist). Same bug
    // as cmdReload had : a SHA bump triggered this self-reload, which spawned
    // timer.ts → ERR_MODULE_NOT_FOUND → the timer killed itself on every
    // commit to the live checkout. (The "timer.ts" name lives on only in
    // comments; the actual module is loop.ts.)
    const timerScript = join(root, "src/claude-loop/loop.ts");
    const tsxBin = shQuote(join(root, "node_modules", ".bin", "tsx"));
    // #859 plan A — NE PAS écrire `child.pid` ici : c'est le pid du wrapper
    // bash → tsx (qui exec puis fork le vrai node timer.ts → zombie). C'est
    // la régression #413 sur le chemin reload. Le NOUVEAU timer écrit son
    // propre `process.pid` à boot (ligne 196). Fenêtre de race ~1s
    // (spawn → tsx boot → write) acceptable, identique au boot initial.
    spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd!))} && exec ${tsxBin} ${shQuote(timerScript)}`,
    ], { detached: true, stdio: ["ignore", logFd, logFd], env: respawnEnv }).unref();
    log("loop respawned (detached) — new child will record its own pid at boot");
    process.exit(0);
}

// #999 — every wake (event hint or periodic drain) routes through the
// SINGLE renderer `buildContextPhrase` : it pops the FIFO head (rendered
// by its kind branch) or falls to the backlog branch when the FIFO is
// empty. An event hint anchors the comment-centric format (eventHint path).
// The legacy `buildWakePhrase` second renderer was removed (dead code).
// Async because the renderer queries the daemon; tryWakeInner already
// awaits checkHasWork so adding another await here is a no-op.
//
// #544 david `hdc7hn` : avant d'emettre le directive "Handle ticket #X",
// on check si cet agent est stakeholder (assignee/claimant/@mentioné).
// Sinon on retombe sur le contextPhrase generique (info only, pas
// d'ordre "Handle" qui pousserait l'agent à toucher un ticket qui n'est
// pas le sien). Filtre agent-side car la même SSE peut servir plusieurs
// usages (UI notifs vs wake) ; la décision "wake me?" est privée à
// l'agent.
async function pickPhrase(hint?: WakeHint): Promise<{ phrase: string; headMessageId: number | null; hasContent: boolean; backlogTicketId: number | null }> {
    // #749 — every wake path (SSE direct, AFK-clear-drain, stop-hook
    // post-turn, heartbeat) routes through `buildContextPhrase` so the
    // content is uniform: pop the oldest unread FIFO event, fall back
    // to the backlog head when empty. Returns the head's message id so
    // the inject site can mark it seen (a delivered wake = the agent
    // has read the event).
    // #999 — an event-triggered wake carries a `hint` (the SSE ping). It must
    // render the COMMENT-centric format anchored on that event, never the
    // backlog ticket-centric "Triage" branch (reserved for the no-hint
    // heartbeat path). We pass the resolved event down so `buildContextPhrase`
    // stays comment-centric even if the FIFO already pruned/raced past the ping.
    let eventHint: WakeEventHint | undefined;
    if (hint?.ticket_id) {
        const me = process.env.AIBALL_AGENT;
        const ctx = await fetchWakeContext(hint, me);
        if (!ctx.stakeholder) {
            log(`wake-hint #${hint.ticket_id}${hint.comment_hashid ? ` (comment #${hint.comment_hashid})` : ""} not for me (${me}) — generic FIFO-pop phrase`);
        }
        eventHint = {
            ticketId: hint.ticket_id,
            commentHashid: hint.comment_hashid,
            commentBody: ctx.commentBody ?? hint.comment_body,
        };
    }
    const result = await buildContextPhrase(
        client(),
        process.env.AIBALL_PROJECT ?? null,
        pingsPath(sd!),
        eventHint,
    );
    // #848 david `chkb5z` — le post-boot reminder n'est PAS prepended.
    // Inject standalone via `turnActor.on("turn:settled")` ; pickPhrase
    // ne touche plus à `postBootInjectText`.
    return result;
}

/**
 * #544 + #555 — one-shot fetch qui sert à la fois (a) le filtre stakeholder
 * et (b) l'extraction du body du commentaire pour l'inject dans le wake.
 * Mutualise l'appel daemon (auparavant `isWakeStakeholder` faisait ce fetch
 * pour le seul check booléen, on jetait le body — maintenant on le retient).
 *
 * **Stakeholder** = true iff l'un de :
 *   - l'agent tient un claim live sur le ticket
 *   - l'agent est l'assignee explicite
 *   - le body du commentaire @-mentionne l'agent
 *
 * Reporter (`by_agent`) seul N'est PAS suffisant (david `hdc7hn` :
 * « aiball-win est le reporter/owner mais il doit pas le claim »).
 *
 * **commentBody** = extrait markdown-strippé via `stripMarkdown`, renseigné
 * dès que le hint porte un `comment_hashid` et que le comment est trouvé
 * dans la réponse — indépendamment du verdict stakeholder (le caller décide
 * s'il l'utilise).
 *
 * Fail-open sur stakeholder : si la lookup foire (daemon down, hashid
 * manquant, timeout), on suppose stakeholder=true → mieux vaut un wake
 * gratuit qu'un miss silencieux. commentBody reste vide dans ce cas.
 */
async function fetchWakeContext(
    hint: WakeHint,
    me: string | undefined,
): Promise<{ stakeholder: boolean; commentBody?: string }> {
    if (!me || !hint.ticket_id) return { stakeholder: true };
    try {
        const resp = await client().getTicket(hint.ticket_id, { brief: true }) as {
            ticket?: { claimant?: string | null; assignee?: string | null };
            comments?: Array<{ hashid?: string; body?: string | null }>;
        };
        const t = resp.ticket;
        if (!t) return { stakeholder: true };
        // Extraire body avant le verdict pour que l'enrichment marche aussi
        // sur le chemin claim/assignee (sans @-mention dans le body).
        let commentBody: string | undefined;
        let mentionsMe = false;
        if (hint.comment_hashid && Array.isArray(resp.comments)) {
            const cm = resp.comments.find((x) => x.hashid === hint.comment_hashid);
            const body = cm?.body ?? "";
            if (body) commentBody = stripMarkdown(body);
            // Same lookbehind shape as the formatting mention regex (#535),
            // minus `>` to also catch mentions au start de markdown paragraphs.
            const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`(?<![\\w@"'/])@${escaped}\\b`);
            mentionsMe = re.test(body);
        }
        const stakeholder = t.claimant === me || t.assignee === me || mentionsMe;
        return { stakeholder, commentBody };
    } catch {
        return { stakeholder: true };
    }
}

// #264: timestamp of the loop's last send-keys, so the human-typing
// detector can exclude the loop's own injected text from "a human typed".
/** #624 david `62ys4g` + #629 `44ca88` + #611 `78seq9` — capture the pane
 *  and write the pane-* markers so the LoopState service sees the freshest
 *  values. Called by tryWake (out-of-band SSE) and the heartbeat probe
 *  (~30s).
 *
 *  `paneReady` is smarter than a raw "prompt signature visible" check :
 *  picker UI text (`Resume session`, `Resume from summary`, `Don't ask
 *  me again`, `Compact this conversation`) AND transient loaders
 *  (`Resuming conversation…`, `Compacting conversation`) all force
 *  `paneReady=false`. Without this guard, the splash's `Claude Code v`
 *  match → ends boot prematurely (#629 Bug 4 david `bgbkmg` + `jt3d6t`).
 *
 *  #611 `78seq9` : also detect API errors here (api-500, rate-limited,
 *  overloaded). Stop-hook does the same on turn-end ; the heartbeat
 *  catches errors that crashed claude mid-turn (no Stop hook fires).
 *  `armErrorBackoff` writes `busy-defer-until` which the state machine
 *  already gates against — no new plumbing needed. */

// #845 Phase B+C — pane-watchers + zones + event-driven ipcState writes.
// Each inline regex from the pre-refactor `refreshPaneMarkers` is now a
// dedicated watcher under `src/claude-loop/pane-watchers/`. The
// orchestrator (`paneObs`) holds two zones — `boot` (pickers + resuming
// + compactConfirm) and `runtime` (prompt + busy + interrupted + error
// + compacting). #872 Phase 3 — `mainSse` enters both at startup (sauf
// `boot` skippé en cas de respawn handoff sealed) ; le BootMachine
// acteur sort `boot` à la transition `sealed` (terminal, pas de
// ré-entrée).
//
// Phase C : the legacy `setIpc*` calls used to fire every tick from
// `refreshPaneMarkers`'s body, regardless of whether anything changed.
// Now each watcher's `change` event drives the corresponding setter —
// `refreshPaneMarkers` shrinks to a pane capture + `paneObs.tick()` +
// the pane-service-sync bridge + the error backoff escalation (which
// stays poll-driven because each tick with errId set increments the
// backoff attempts counter — by design).
const pickerSessionW = new PickerSessionWatcher();
const pickerModeW = new PickerModeWatcher();
const resumingW = new ResumingWatcher();
const compactConfirmW = new CompactConfirmWatcher();
const promptW = new PromptWatcher();
const busyW = new BusyWatcher();
const interruptedW = new InterruptedWatcher();
const idlePromptW = new IdlePromptWatcher();
const errorW = new ErrorWatcher();
const healthCheckW = new HealthCheckWatcher();
const promptZoneW = new PromptZoneWatcher();
const promptInputW = new PromptInputWatcher();
const paneObs = new PaneObserver();
paneObs.registerZone(new Zone("boot", [pickerSessionW, pickerModeW, resumingW, compactConfirmW]));
paneObs.registerZone(new Zone("runtime", [
    promptW, busyW, interruptedW, idlePromptW, errorW, getCompactingDetector(), healthCheckW, promptZoneW, promptInputW,
]));
// Runtime zone toujours actif ; boot zone n'est entré que si on n'est
// pas déjà sealed (cas respawn handoff #868 : bootComplete déjà true).
// Le BootMachine acteur (#872 Phase 3) sort la zone "boot" via son
// subscriber dès qu'il atteint l'état terminal `sealed`.
paneObs.enter("runtime");
if (getIpcState().bootComplete !== true) {
    paneObs.enter("boot");
}

// `paneReady` is composed : prompt visible AND no picker/transient on
// screen. Any watcher that contributes to the disjunction needs to
// trigger a recompute on its change.
const refreshPaneReady = (): void => {
    if (!sd) return;
    const promptVisible = promptW.snapshot().visible;
    const pickerOrTransient = pickerSessionW.snapshot().visible
        || pickerModeW.snapshot().visible
        || resumingW.snapshot().visible
        || compactConfirmW.snapshot().visible
        || getCompactingDetector().snapshot().active;
    setPaneReady(sd, promptVisible && !pickerOrTransient);
};

// Wire watcher events → ipcState side-effects once at module init. The
// `change` event fires only on transitions, so each setter call below
// is a real value flip (no wasted no-op writes per tick).
// #1009 — LEVEL+DECAY boot tracking : each visible boot module RE-SIGNALS
// itself every pane tick via `forwardModuleSeen` (polled in refreshPaneMarkers).
// No begin/end pairing — a module that disappears simply stops being signalled
// and falls out of its remanence window (the #994 resume_mode leak class is
// gone). `begin` handlers stay only for their one-shot side-effects (auto-cross).
function forwardModuleSeen(name: string, nowMs: number, remanenceMs?: number): void {
    if (bootActor && !bootActor.getSnapshot().matches("sealed")) {
        bootActor.send({ type: "MODULE_SEEN", name, nowMs, remanenceMs });
    }
}
if (sd) {
    pickerSessionW.on("change", (s) => { setResumeSessionPicker(sd, s.visible); refreshPaneReady(); });
    pickerSessionW.on("begin", () => {
        // #639 david `3yz6qa` — auto-cross loop-side : le watcher détecte le
        // picker session, on envoie Enter (= pick latest). CL_RESUME_PICK
        // = "abort" laisse l'humain choisir. L'inject + ses retries vivent
        // dans crossResumePicker() (appelé ici ET re-tenté par heartbeat tant
        // que le picker reste visible — anti boot-race, cf. ci-dessous).
        if ((process.env[CL_ENV.RESUME_PICK] ?? "latest") === "abort") {
            log("watcher: resume_picker begin → CL_RESUME_PICK=abort, no auto-cross");
            return;
        }
        log("watcher: resume_picker begin → auto-cross (pick=latest, Enter)");
        crossResumePicker();
    });
    pickerModeW.on("change", (s) => { setResumeModePicker(sd, s.visible); refreshPaneReady(); });
    pickerModeW.on("begin", () => {
        // #639 — summary-vs-as-is picker. Default "as-is" = Down + Enter.
        // "summary" = juste Enter. "abort" laisse l'humain.
        const mode = process.env[CL_ENV.RESUME_MODE] ?? "as-is";
        if (mode === "abort") {
            log("watcher: resume_mode begin → CL_RESUME_MODE=abort, no auto-cross");
            return;
        }
        log(`watcher: resume_mode begin → auto-cross (mode=${mode})`);
        // #965 — Down + Enter via inject.sock. Down = `\x1b[B` (CSI).
        // Pas de fallback send-keys (cf. resume_picker plus haut).
        void (async () => {
            if (mode === "as-is") {
                if (!(await injectRawBytes(sd!, "\x1b[B"))) {
                    log("watcher: resume_mode — inject FAILED for Down (proxy bug ?). Stuck — investiguer.");
                    return;
                }
            }
            if (!(await injectRawBytes(sd!, "\r"))) {
                log("watcher: resume_mode — inject FAILED for Enter (proxy bug ?). Stuck — investiguer.");
            }
        })();
    });
    resumingW.on("change", (s) => { setResuming(sd, s.visible); refreshPaneReady(); });
    compactConfirmW.on("change", () => refreshPaneReady());
    promptW.on("change", () => refreshPaneReady());
    // #890/#994/#1014 — paneBusy is now owned by the per-tick composite busy
    // decay-stack in refreshPaneMarkers (busy-stack.ts): `esc to interrupt`
    // visible → seenProof(esc), pane-idle → releaseAll. busyW.on just feeds the
    // SanityController stale-busy detector.
    busyW.on("change", (s) => {
        if (s.visible) getSanityService().busyLatched();
        else getSanityService().busyCleared();
    });
    // #898 — SanityController consumer : clear le latch quand aucun signe
    // d'activité depuis STALE_BUSY_MS (= path anormal, Stop hook perdu).
    getSanityService().getActor().on("sanity:clear_paneBusy", (ev) => {
        log(`sanityMachine: sanity:clear_paneBusy reason=${ev.reason} atMs=${ev.atMs} → setPaneBusy(false)`);
        busyProofs = releaseBusyProofs(); // #1014 — drop every proof, else next tick re-arms
        setPaneBusy(sd, false);
    });
    // #898 david `<chat>` : "ctrl+t to show task" présent SANS "esc to
    // interrupt" = signal POSITIF d'idle prompt. Si esc+ctrl+t ensemble
    // → busy ; ctrl+t seul → pas busy. Force clear le latch paneBusy
    // (= covers le path #890 latch design où busyW.change(false) ne
    // clear pas intentionnellement parce que la regex bouge).
    idlePromptW.on("begin", () => {
        log("watcher: idle_prompt begin → setPaneBusy(false) (positive idle signal)");
        busyProofs = releaseBusyProofs(); // #1014 — positive idle = release all proofs
        setPaneBusy(sd, false);
    });
    interruptedW.on("change", (s) => setInterrupted(sd, s.visible));
    // #949 — bridge the native health-check prompt visibility → state
    // machine. The watcher fires `begin` when Claude Code's native
    // session-feedback prompt appears and `end` when it leaves the
    // footer. The machine logs each transition via its `actor.on`
    // consumer below ; today that's the entire downstream side-effect
    // (no IPC field, no bar paint — see ticket scope).
    healthCheckW.on("begin", () => getHealthCheckService().promptDetected());
    healthCheckW.on("end", () => getHealthCheckService().promptCleared());
    getHealthCheckService().getActor().on("health:prompt_detected", (ev) => {
        log(`healthCheckMachine: health:prompt_detected atMs=${ev.atMs}`);
        setIpcHealthPromptVisible(true);
    });
    getHealthCheckService().getActor().on("health:prompt_cleared", (ev) => {
        log(`healthCheckMachine: health:prompt_cleared atMs=${ev.atMs}`);
        setIpcHealthPromptVisible(false);
    });
    // #953 david `f72kpq` : PromptZoneWatcher → glyph `❯` dans la barre.
    promptZoneW.on("begin", () => {
        log("watcher: prompt_zone begin → setIpcPromptZoneVisible(true)");
        setIpcPromptZoneVisible(true);
    });
    promptZoneW.on("end", () => {
        log("watcher: prompt_zone end → setIpcPromptZoneVisible(false)");
        setIpcPromptZoneVisible(false);
    });
    // #993 — colour the `❯` glyph when the prompt has unsent text.
    promptInputW.on("begin", () => {
        log("watcher: prompt_input begin → setIpcPromptHasInput(true)");
        setIpcPromptHasInput(true);
    });
    promptInputW.on("end", () => {
        log("watcher: prompt_input end → setIpcPromptHasInput(false)");
        setIpcPromptHasInput(false);
    });
    getCompactingDetector().on("change", (s) => { setCompacting(sd, s.active); refreshPaneReady(); });
    // #1009 — compacting no longer forwards begin/end edges to the boot machine ;
    // it re-signals via MODULE_SEEN from the per-tick poll in refreshPaneMarkers
    // (like the other transient modules).
}

// #639/#965 auto-cross : inject Enter to dismiss claude's resume-session picker
// (pick=latest). Inject-only — NO send-keys fallback (would arm NOT AFK 10m via
// stdin ; #974). The begin-time inject can be LOST at boot when the PTY proxy
// hasn't subscribed to loop.sock yet (injectRawBytes resolves true — the frame
// reached the timer — but the timer's rebroadcast finds no proxy → Enter
// dropped). begin fires once, so the picker stayed stuck (seen live on skybot
// after a reload). Fix : the heartbeat re-calls this WHILE the picker is still
// visible, so a lost Enter is re-sent once the proxy is up — anti-race, not a
// fallback. Rate-limited so we never machine-gun Enter.
let lastPickerCrossAtMs = 0;
const PICKER_CROSS_RETRY_MS = 3000;

// #1014 — composite busy decay-stack. Each pane tick re-signals the proofs
// currently present (turn / esc / compacting) ; `paneBusy` = ≥1 proof still
// holds. Module state because it accumulates across ticks. Released wholesale
// by pane-idle + the explicit clears (Stop hook, sanity, turn:settled).
let busyProofs: BusyProofs = new Map();
function crossResumePicker(): void {
    if ((process.env[CL_ENV.RESUME_PICK] ?? "latest") === "abort") return;
    lastPickerCrossAtMs = Date.now();
    void (async () => {
        if (!(await injectRawBytes(sd!, "\r"))) {
            log("auto-cross: inject FAILED (proxy bug ?) — retry on next heartbeat while the picker stays visible.");
        }
    })();
}

function refreshPaneMarkers(): void {
    if (!sd) return;
    const paneText = capturePane();
    if (!paneText) return;
    const ipc = getIpcState();
    const isBoot = ipc.bootComplete !== true;
    // Single scan : watchers observe + emit events ; the subscribers
    // above call the legacy ipcState setters on every transition. Cursor was
    // probed by capturePane() just above (lastCursor) — reuse it.
    paneObs.tick(paneText, { nowMs: Date.now(), isBoot, cursorX: lastCursor?.x, cursorY: lastCursor?.y });
    // #1009 — LEVEL+DECAY boot tracking : re-signal every CURRENTLY-VISIBLE boot
    // module to the BootMachine (MODULE_SEEN refreshes its remanence). A module
    // that has disappeared simply isn't signalled → it falls out of its window
    // → boot seals once all modules (incl. the seed) have fallen. No begin/end,
    // so a missed transition can't stick a module (the #994 leak class is gone).
    // No-op once sealed (forwardModuleSeen guards). Uniform across BoolWatcher
    // (visible) + CompactingDetector (active, with its own 10s latch).
    {
        const nowSeen = Date.now();
        if (pickerSessionW.snapshot().visible) forwardModuleSeen("resume_picker", nowSeen);
        if (pickerModeW.snapshot().visible) forwardModuleSeen("resume_mode", nowSeen);
        if (resumingW.snapshot().visible) forwardModuleSeen("resuming", nowSeen);
        if (compactConfirmW.snapshot().visible) forwardModuleSeen("compact_confirm", nowSeen);
        if (getCompactingDetector().snapshot().active) forwardModuleSeen("compacting", nowSeen);
    }
    // #1014 david — busy composite = decay-stack of proofs (cf. busy-stack.ts).
    // Each present proof re-signals (refreshes its remanence) ; `paneBusy` = ≥1
    // proof still holds. Replaces the #992/#994 nextPaneBusy latch : the
    // remanence gives the #890 hysteresis for free (typing pushes `esc to
    // interrupt` out of the footer → the esc proof tient encore quelques ticks)
    // and a turn reinforces a flickering pane. idlePromptVisible = box visible
    // AND NOT promptInputW (cursor left the input origin).
    const idlePromptVisible = promptZoneW.snapshot().visible && !promptInputW.snapshot().visible;
    const escVisible = busyW.snapshot().visible;
    const inTurn = getTurnService().getActor().getSnapshot().matches("in_turn");
    const nowBusy = Date.now();
    if (inTurn) busyProofs = seenProof(busyProofs, PROOF_TURN, nowBusy);
    if (escVisible) busyProofs = seenProof(busyProofs, PROOF_ESC, nowBusy);
    if (getCompactingDetector().snapshot().active) busyProofs = seenProof(busyProofs, PROOF_COMPACTING, nowBusy);
    // pane-idle (cursor back at origin, esc gone) = authoritative release : drop
    // every proof at once, no waiting for remanence. esc-visible wins (it only
    // shows at the input origin, so arm precedence is preserved).
    if (idlePromptVisible && !escVisible) busyProofs = releaseBusyProofs();
    const composite = busyStackActive(busyProofs, nowBusy);
    if (composite !== getIpcState().paneBusy) setPaneBusy(sd, composite);
    // #1012 — pane-idle = 2nd source of turn-end (the Stop hook can be missed).
    // If the turn observer is still in_turn but the pane is back at a clean idle
    // prompt (box visible, cursor at origin, esc gone), close the turn from the
    // pane. This makes C1 robust (turn-during-boot closes even with no Stop hook)
    // → the session join can fire. One-shot : once turn:ended fires the observer
    // leaves in_turn so this won't re-fire.
    if (idlePromptVisible && !escVisible && inTurn) {
        log("turn-end via pane-idle (Stop hook absent/late) → turnEnded");
        getTurnService().turnEnded(Date.now());
    }
    // Picker markers are AUTHORITATIVELY the current pane scan, not just
    // transitions. The session-start hook sets them true out-of-band ; if it
    // auto-Enters past the picker before a heartbeat captures it, the watcher
    // never observes true→false, so its transition-only `change` can't clear the
    // stale marker — seen live on skybot: the bar stuck on `resume picker:session`
    // at the idle prompt. Reconcile each tick so a gone picker clears even
    // without a watcher transition.
    if (pickerSessionW.snapshot().visible !== (getIpcState().resumeSessionPickerActive === true)) {
        setResumeSessionPicker(sd, pickerSessionW.snapshot().visible);
        refreshPaneReady();
    }
    if (pickerModeW.snapshot().visible !== (getIpcState().resumeModePickerActive === true)) {
        setResumeModePicker(sd, pickerModeW.snapshot().visible);
        refreshPaneReady();
    }
    // Auto-cross boot-race recovery : if the session picker is STILL visible,
    // re-send Enter (the begin-time inject can be dropped when the proxy hasn't
    // subscribed to loop.sock yet). Rate-limited via lastPickerCrossAtMs.
    if (pickerSessionW.snapshot().visible && Date.now() - lastPickerCrossAtMs > PICKER_CROSS_RETRY_MS) {
        log("auto-cross: session picker still visible → retry Enter (boot-race recovery)");
        crossResumePicker();
    }
    // #883 Slice 2 — le push de deadline est maintenant géré par le
    // "push manager" dans mainSse (un setInterval armé/désarmé via
    // subscribe sur `activeModules.size`). `refreshPaneMarkers` se
    // contente d'observer (= forward begin/end events aux watchers).
    void isBoot; // (kept for the error backoff branch below)
    // #611 — error backoff escalation : each tick with errId !== null
    // increments the backoff attempts counter (= the next retry pushes
    // further into the future). Event-only wiring would only arm once
    // per begin transition and silently cap the backoff at attempt=1.
    // So we keep this branch poll-driven, reading the watcher snapshot.
    //
    // #948 david `9hafg2` : gate on `!paneBusy`. Claude busy = retry en
    // cours = erreur passée (la ligne d'erreur reste dans le scrollback
    // 8-lignes mais elle n'est plus l'état actif). Sans ce gate, le
    // backoff escalade silencieusement à chaque heartbeat tant que la
    // ligne est visible, jusqu'au cap 10 min — bloquant tous les wakes.
    const errId = ipc.paneBusy ? null : errorW.snapshot().errorId;
    if (errId) {
        const bo = armErrorBackoff(sd, errId);
        log(`probe: api error '${errId}' detected → backoff ${bo.ms}ms (attempt ${bo.attempts}, until=${bo.untilIso})`);
    } else if (readErrorBackoff(sd)) {
        // Pane is clean again — clear the backoff counter so a future
        // error restarts at the base delay.
        resetErrorBackoff(sd);
        log("probe: pane error cleared — resetting backoff counter");
    }
    // #647 Slice 3 : mirror the marker-file state into the typed
    // PaneService singleton. Bar (slice 4) and future subscribers read
    // from there instead of doing existsSync(...) x N.
    syncPaneServiceFromMarkers(sd, { errId });
}

let lastSendAt = 0;
async function sendKeys(phrase: string, headMessageId?: number | null, interruptFirst = false, backlogTicketId?: number | null): Promise<void> {
    // Touch wake-in-flight BEFORE the actual send-keys so the
    // UserPromptSubmit hook can flag from_auto_wake=true (the marker
    // only flags the auto-wake, it's NOT a gate anymore — the post-wake
    // tempo via busy-defer is what spaces out wakes).
    lastSendAt = Date.now();
    // Panic wakes interrupt claude mid-turn so the injected phrase
    // actually reaches the prompt instead of queueing behind the
    // current generation. Two Escapes mirror the user's own "abort"
    // chord; a single Escape is sometimes consumed by claude's TUI.
    if (interruptFirst) {
        // #965 — Escape Escape via inject.sock (le proxy ne le voit pas
        // comme une frappe humaine via son stdin).
        // #974 — PAS de fallback send-keys : un inject raté = bug proxy à
        // investiguer, pas à contourner via tmux (qui ré-armerait NOT AFK
        // 10m via le détecteur de frappe). Fail loud, interrupt skippé.
        if (!(await injectRawBytes(sd!, "\x1b\x1b"))) {
            log("self-interrupt: inject ÉCHOUÉ (proxy bug ?) — NO send-keys fallback, interrupt skippé. Investiguer.");
        }
        await sleep(500);
    }
    const wakeDelivered = await injectWakePhrase(`${tname}.0`, phrase, () => {
        const nowMs = Date.now();
        // #879 — fire WAKE_DELIVERED on the WakeMachine actor. Le
        // subscriber bridge synchronise `ipc.wakeInFlightAtMs` +
        // `ipc.lastWakeAtMs`. Le emit `wake:delivered` est consommé
        // par les listeners dans mainSse (markMessageSeen +
        // recordBacklogWake) — ces actions vivent en consumer, pas
        // dans le callback (purity contract #877).
        getWakeService().delivered(phrase, headMessageId ?? null, nowMs);
        // #879 — armBusyDefer redondant avec le cooldown state du
        // WakeMachine ; gardé pendant la transition pour que les
        // consumers externes (stop-hook etc.) qui lisent ipc.busyDeferUntilMs
        // continuent à voir le gate.
        armBusyDefer(sd!, WAKE_COALESCE_WINDOW_MS);
        // Mark the FIFO-head ping as seen the moment the inject crosses
        // the gate. Fire-and-forget. (Couldn't easily move to the
        // `wake:delivered` consumer because `headMessageId` would need
        // to be plumbed through the emit payload — already done above.
        // The consumer in mainSse handles it via the payload.)
        if (backlogTicketId) {
            void client().recordBacklogWake(backlogTicketId).catch(() => {});
        }
    });
    // #974 — fail loud quand le proxy était censé recevoir l'inject mais a
    // échoué (loop.sock présent, inject KO). Pas de fallback tmux : c'est un
    // bug proxy à investiguer. Le wake est droppé (le ping reste consommé,
    // mais un proxy mort = pane mort = la loop est de toute façon cassée).
    if (!wakeDelivered) {
        log("wake: injectWakePhrase ÉCHOUÉ via proxy (loop.sock présent, inject KO) — proxy bug ? wake droppé, NO tmux fallback. Investiguer.");
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// #264 (david #c5fgha "ok B"): near-live detection of a human typing in
// the pane, via pane-diff. While claude is AT THE PROMPT (idle marker
// present = not mid-turn, no output streaming), poll the bottom of the
// pane; if it changes and the loop didn't just send-keys, a human is
// typing → refresh the human-typing marker (drives the bicolor bar chip
// in setTmuxStatus). Fail-safe: never throws — it must not
// disturb the wake loop. NOTE: only reliable at the prompt; detecting
// typing WHILE claude streams is out of scope for pane-diff.
const HUMAN_POLL_MS = 1500;
let prevPaneTail = "";
let humanChipShown = false;
function recentlySentKeys(): boolean {
    return Date.now() - lastSendAt < 3000;
}
function detectHumanTyping(): void {
    try {
        // #269: when the PTY proxy fronts claude it feeds the human-typing
        // marker directly (live, busy included) and wake injection bypasses
        // tmux stdin — so this pane-diff heuristic is both redundant AND
        // wrong here (it would flag socket-injected wakes as human typing,
        // since recentlySentKeys only tracks tmux send-keys). The proxy owns
        // the marker; skip. Pane-diff stays the fallback for non-proxy loops.
        // #730 step 3 — gate on `loop.sock` instead of the legacy
        // `inject.sock` (folded into loop.sock).
        if (existsSync(loopSockPath(sd!))) return;
        if (readIdleSinceMs(sd!) === null) {
            // Mid-turn / streaming → reset baseline so the post-busy
            // prompt isn't diffed against a stale pre-busy capture.
            prevPaneTail = "";
            return;
        }
        const pane = capturePane();
        if (!pane) return;
        const tail = pane
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0)
            .slice(-4)
            .join("\n");
        if (prevPaneTail && tail !== prevPaneTail && !recentlySentKeys()) {
            // #840 `4z59jt` — IPC seul. setIpcHumanTypingAtMs ← touchHumanTyping.
            touchHumanTyping(sd!);
            // #745 phase B — user-took-over marker dropped (AFK SM owns
            // the "human present" signal). La pane-diff fallback ne
            // refresh que humanTyping ; l'AFK SM armera NOT AFK 10m sur
            // le prochain typing event dispatché par le proxy.
            log("human-typing detected (prompt area changed at idle)");
        }
        prevPaneTail = tail;
        // Edge-repaint the bicolor chip when it appears / clears (the
        // marker expires ~HUMAN_TYPING_TTL_SEC after the last keystroke).
        const showing = humanIsTyping(sd!);
        if (showing !== humanChipShown) {
            // #862 Slice 5 — setTmuxStatus(IDLE) retiré. paneBusy=false
            // suffit pour que BarRenderer dérive idle.
            setIpcStateTagInfo(null);
            humanChipShown = showing;
        }
    } catch { /* never throw from the detection poll */ }
}

// Cached client for the default-path direct API call (no fork). The
// process is long-lived so the keep-alive socket / token resolution
// stays warm across ticks. Passed into the shared `checkHasWork`
// helper (state.ts) so the keep-alive socket stays warm; the helper
// itself centralizes the empty/default/custom branching (#B.141).
let aiballClient: AiballClient | null = null;
function client(): AiballClient {
    if (!aiballClient) aiballClient = new AiballClient();
    return aiballClient;
}

/**
 * Common wake path used by SSE-driven and timer-driven modes. Honors
 * all the gates (idle-since, user-grace, optional check-cmd) and only
 * actually fires send-keys when claude is at the prompt with work to
 * do. Returns true iff a wake was sent — useful for logging.
 *
 * `manualWake = true` (file-marker bypass) skips the user-grace AND
 * the check-cmd; only the idle-since gate stays because pinging over
 * a busy claude is always wrong.
 */
// #B.205 — in-flight mutex: bursts of SSE pings used to queue at
// `await checkHasWork` then all fire send-keys at once, pasting N
// phrases. Only the first wake proceeds; the Stop hook / next
// heartbeat picks up what's still unread post-turn.
// #879 — `tryWakeInFlight` Promise mutex remplacé par le WakeMachine
// acteur (cf. wake-machine.ts). L'état `inFlight` du machine joue le
// rôle de mutex, et la cooldown post-fire (= WAKE_COALESCE_WINDOW_MS)
// est encodée en state au lieu de via `armBusyDefer`.

// #848 (david `chkb5z`) — standalone post-boot inject. Au lieu de
// prepend à un wake (= ancien mécanisme `121a042` qui leakait sur
// d'autres messages), on attend `turn:settled` après `boot:sealed` et
// on fire un sendKeys séparé avec juste le prompt. Garanties :
//   - one-shot par session (`postBootRemindersSent` flag)
//   - standalone (= jamais prepended à autre message)
//   - skip si claude jamais idle stable (= force injection évitée)
let postBootRemindersSent = false;
// #1033 — fetch the 3 bar counters (open/backlog/events) and paint them.
// Factored from the SSE-ping + heartbeat paths so it can ALSO fire eagerly
// on `wakeBus.on("hello")` (aiball connection established / re-established) →
// `o:N b:N e:N` appears as soon as we can talk to the daemon, instead of only
// at the first heartbeat (~interval into the boot). Best-effort ; `setIpcCounters`
// is skipped when all 3 fetches fail so the last-known segment is preserved (#835).
async function refreshCounters(): Promise<void> {
    try {
        const cooldownSec = process.env[CL_ENV.BACKLOG_COOLDOWN_SEC] ?? "3600";
        const backlogQuery: Record<string, string | undefined> = {
            backlog: "1",
            limit: "500",
            cooldown_sec: cooldownSec,
        };
        if (loopProject) backlogQuery.project = loopProject;
        const [pingsR, projectsR, backlogR] = await Promise.allSettled([
            client().pingsCount() as Promise<{ unread?: number }>,
            client().listProjectsDetailed() as Promise<Array<{ name: string; open_count?: number }>>,
            client().listTickets(backlogQuery) as Promise<unknown[]>,
        ]);
        const { open, backlog, events } = deriveBarCounters(pingsR, projectsR, backlogR, loopProject);
        if (events !== null || open !== null || backlog !== null) {
            setIpcCounters({ open, backlog, events });
        }
    } catch { /* counter sync best-effort */ }
}
// #999 model (a) — the latest SSE event awaiting a drain. Set by the SSE
// ping handler (non-panic), consumed by the `turn:settled` drain (the single
// 10s tempo driver) so the wake renders comment-centric via the eventHint
// path. Cleared on consumption and on `turn:started` (a new turn supersedes a
// stale pending event).
let pendingWakeHint: WakeHint | undefined;
// #1039 — graceful window before the bar goes RED on a lost IPC link. A peer
// that went stale but reconnects within this window must NOT flash red. Armed
// on `onClientStale`, cancelled on `onClientConnect`.
const LINK_DOWN_GRACE_MS = 10_000;
let linkDownGraceTimer: NodeJS.Timeout | null = null;
function armLinkDownGrace(): void {
    if (linkDownGraceTimer) return; // already counting down
    linkDownGraceTimer = setTimeout(() => {
        linkDownGraceTimer = null;
        setIpcLinkDown(true);
        log(`loop.sock: IPC link still down after ${LINK_DOWN_GRACE_MS / 1000}s grace — bar RED`);
    }, LINK_DOWN_GRACE_MS);
}
function cancelLinkDownGrace(): void {
    if (linkDownGraceTimer) { clearTimeout(linkDownGraceTimer); linkDownGraceTimer = null; }
}
async function tryWake(reason: string, manualWake = false, hint?: WakeHint, panicMode = false): Promise<boolean> {
    const wakeSvc = getWakeService();
    if (!wakeSvc.isIdle()) {
        const state = String(wakeSvc.getActor().getSnapshot().value);
        log(`skip wake (${reason}) — wakeMachine state=${state} (in-flight or cooldown)`);
        return false;
    }
    wakeSvc.request(reason);
    let delivered = false;
    try {
        delivered = await tryWakeInner(reason, manualWake, hint, panicMode);
        return delivered;
    } finally {
        // #879 fix : cooldown UNIQUEMENT après une delivery réussie. Si
        // tryWakeInner a skip (zen, no work, gate refusé), retour direct
        // à idle pour que le prochain wake (SSE ping, backlog, heartbeat)
        // ne soit pas bloqué 10s pour rien.
        if (delivered) {
            wakeSvc.completed();
        } else {
            wakeSvc.skipped();
        }
    }
}
// A panic wake bypasses ONLY the busy gates (busy-defer, pane shows
// "esc to interrupt", pane shows /compact). AFK / zen / idle-marker
// still apply — if the loop is told to shut up, panic respects that;
// if claude was never seen idle the wake would be lost anyway.
const PANIC_BYPASSABLE_REASONS = /busy-defer|esc to interrupt|\/compact/;
async function tryWakeInner(reason: string, manualWake: boolean, hint?: WakeHint, panicMode = false): Promise<boolean> {
    // #749 david — `--zen` kill switch. Presence of `zen` marker mutes ALL
    // wake injections (including manualWake, including afk-cleared-drain).
    // Highest-priority gate — runs before every other check. Toggle via
    // `claude-loop zen <name>` or `claude-loop --zen` at start.
    if (existsSync(zenPath(sd!))) {
        log(`skip wake (${reason}) — zen mode (touch ${zenPath(sd!)} to mute, remove to unmute)`);
        return false;
    }
    // #848 david `<chat>` : la fenêtre [boot:sealed → loop:start] (= 10s)
    // est gérée par le WakeController lui-même via l'état initial `gated`.
    // REQUEST_WAKE pendant gated emit cleared(boot_gated) et stay gated.
    // Aucun check imperatif ici — la SM le gate.
    // #727 V1 Slice B fix — the legacy idle-since pre-gate used
    // `existsSync(idleMarkerPath)`, but Slice B-3 stops the hooks from
    // writing that file when the ws emit succeeds. `readIdleSinceMs`
    // checks the in-memory truth first (set by the HookService Stop
    // subscriber) with the file mtime as fallback, matching what the
    // central gate (`computeWakeGate`) sees.
    if (readIdleSinceMs(sd!) === null) {
        log(`skip wake (${reason}) — no idle marker (claude is busy or boot grace not yet elapsed)`);
        return false;
    }
    // #627 + #624 david `62ys4g` — single central gate via the LoopState
    // service. Every external signal is a marker — including pane state
    // (busy/ready/compacting/interrupted), written by the heartbeat
    // pane probe below. tryWake just reads the verdict.
    if (!manualWake) {
        // Refresh pane markers before computing the view so the gate
        // sees the just-observed state (the heartbeat probe at line
        // ~937 also writes them, but tryWake can fire from SSE
        // out-of-band).
        refreshPaneMarkers();
        const view = computeLoopView(readLoopStateInput(sd!));
        if (!view.wakeAllowed) {
            const skipReason = view.wakeSkipReason ?? "";
            if (panicMode && PANIC_BYPASSABLE_REASONS.test(skipReason)) {
                log(`panic (${reason}) — bypassing busy gate (${skipReason})`);
            } else {
                log(`skip wake (${reason}) — ${skipReason}`);
                return false;
            }
        }
    }
    let gateHash: string | undefined;
    if (!manualWake) {
        const gate = await checkHasWork(
            checkCmd,
            client(),
            process.env.AIBALL_PROJECT ?? null,
            sd!,
        );
        gateHash = gate.landscapeHash;
        // #516 (david `r59bkm` plan B) — un consumer no_claim ne peut pas
        // prendre de tickets de la pool générale. Pour lui, l'activité ne
        // vient QUE de pings directs (assignment / @mention / follower
        // ticket). Le leg "actionable count > 0" trigger des wakes
        // parasites où il n'a rien à faire. On gate ce leg sur les pings
        // exclusivement pour les no_claim — les autres consumers gardent
        // le comportement antérieur (actionable + pings).
        const isNoClaim = process.env.AIBALL_NO_CLAIM === "1";
        if (isNoClaim && gate.pingsCount === 0) {
            log(`skip wake (${reason}) — no_claim + no pings (actionable=${gate.openCount} but not for this consumer)`);
            return false;
        }
        if (!gate.has) {
            // #379 drained-reminder branch. The timer is the SOLE writer of the
            // drained-state marker (heartbeat-owned) → no cross-process race with
            // the hooks. Fires only when a GATED backlog remains (actionable=0,
            // open>0) and the configured strategy says so. Default `silent` →
            // never fires (zero regression). State is persisted on EVERY drained
            // tick so backoff/stale/once track when the landscape appeared.
            const strat = parseDrainedStrategy(cfg.drained_strategy);
            const drainable = strat.kind !== "silent"
                && gate.openCount === 0
                && gate.totalOpenCount > 0
                && gate.landscapeHash !== undefined;
            if (drainable) {
                const dec = decideDrainedWake({
                    strategy: strat,
                    hash: gate.landscapeHash!,
                    lastActivityMs: gate.lastActivityMs,
                    now: Date.now(),
                    prev: readDrainedState(sd!),
                });
                writeDrainedState(sd!, dec.next);
                if (!dec.wake) {
                    log(`skip wake (${reason}) — drained (${strat.kind}) not due (open=${gate.totalOpenCount})`);
                    return false;
                }
                log(`drained wake (${reason}) — strategy=${strat.kind} open=${gate.totalOpenCount}`);
                // fall through to send-keys
            } else {
                log(`skip wake (${reason}) — checkHasWork false (pings=${gate.pingsCount} actionable=${gate.openCount} open=${gate.totalOpenCount})`);
                return false;
            }
        }
    }
    const { phrase, headMessageId, hasContent, backlogTicketId } = await pickPhrase(hint);
    // If there's nothing actionable to surface (no FIFO head, no backlog,
    // no triggered gate), don't fire — david: "si y a rien on dit rien".
    // Manual wakes and panic still go through; their content is the
    // signal, not the phrase. The bypass for triggered gates lives
    // inside ContextPhraseResult.hasContent.
    if (!hasContent && !manualWake && !panicMode) {
        // #825 david `b63ez5` — strict binary rule : a wake fires ONLY
        // when there's a FIFO event (comment / lifecycle / new ticket /
        // decision event) OR a backlog tier-2 ticket. No "cultural ping"
        // fall-through anymore — the pre-fix landscape-moved branch
        // ("Anybody out there?") inflated the wake stream with useless
        // pings that david called out as noise ("on a toujours ce genre
        // de message complètement inutile. soit on a un event soit un
        // ticket de backlog soit on skip"). #813 (the structural landscape
        // hash that drove the cultural ping) is now only used as a dedup
        // guard for the actionable legs, not as a wake trigger.
        log(`skip wake (${reason}) — nothing actionable (no FIFO event, no backlog)`);
        return false;
    }
    // #840 — wakeRequested is IPC seul (manage.ts émet via UDS). Clear le slot.
    setIpcWakeRequested(null);
    // #831-followup — defensive : if the assembled phrase is empty for
    // any reason (own-comment ping where the builder filtered the head
    // and somehow didn't synth a culture ; future bug), DON'T proceed
    // with the side-effects. The pre-fix path called setIpcIdleSince(null)
    // + sendKeys("") (= tmux no-op send-keys) + recorded the landscape
    // hash. The cleared idle-since then stayed null FOREVER because no
    // UserPromptSubmit fired (nothing was actually injected) and no Stop
    // followed — so every subsequent heartbeat/SSE was skipped with "no
    // idle marker", and unread events piled up in the bar (e:2) with
    // zero wakes firing. The bug surfaced live during david's session ;
    // this guard makes the empty-phrase case a hard skip so the state
    // can't go silent.
    if (!phrase) {
        log(`skip wake (${reason}) — empty phrase (own-comment filter or builder no-op)`);
        return false;
    }
    // #793 — clear in-memory idle-since: the wake is about to flip claude
    // back to busy. The Stop hook will re-seed it when claude returns.
    // #881 — TurnController acteur : TURN_STARTED transitionne no_turn→in_turn
    // et clear idleSinceMs (bridge subscriber écrit setIpcIdleSince(null)).
    getTurnService().turnStarted(Date.now());
    await sendKeys(phrase, headMessageId, panicMode, backlogTicketId);
    // Landscape hash watermark — same set doesn't re-fire the actionable
    // leg (set-aware dedup). The legacy count watermark fallback was
    // dropped in #814 — its only writer wrote a file no one read.
    if (gateHash !== undefined) recordOpenWakeHash(sd!, gateHash);
    // #862 Slice 5 — setTmuxStatus(BUSY) retiré. paneBusy=true via le
    // pane watcher suffit.
    setIpcStateTagInfo(null);
    log(`wake (${reason}) → '${phrase}'`);
    return true;
}

/**
 * SSE-driven main loop (#B.148 phase C). Subscribes once, lets the
 * daemon push `ping` events, and reacts via `tryWake`. Parallel slow
 * heartbeat handles two things SSE can't:
 *   - `wake-requested` file marker (claude-loop wake NAME)
 *   - SSE-drop safety net (re-verifies via checkHasWork in case the
 *     stream silently dropped under load)
 *
 * On SSE error, the heartbeat keeps running; next iteration re-opens
 * the stream with simple backoff (no aggressive reconnect storm).
 */
async function mainSse(): Promise<void> {
    log(`timer started — SSE mode (heartbeat ${interval}s), check-cmd: ${checkCmd || "(internal SDK)"}`);
    // #B.225: log the install-root SHA so `--log` shows what version
    // of the timer is actually running. `cmdList` / `cmdCheck` diff
    // this against the live HEAD to flag a ghost daemon.
    const bootSha = installRootSha();
    if (bootSha) log(`timer source: install-root SHA ${bootSha.slice(0, 7)}`);
    // #1032 S2 — the timer just (re)started : replay anything the hooks/proxy
    // offloaded while the IPC was down (with original ts) into the central log.
    drainOffloadIntoLog();
    // #793 — seed the idle-since bus value at boot from a pane probe.
    // The SHA-mismatch self-respawn watchdog (#72c604e) spawns a fresh
    // timer with an empty `LoopStateBus`; the legacy `idle-since` file
    // is usually absent on first run, so `readIdleSinceMs` returns null
    // and every wake skips with "no idle marker" until a Stop hook
    // happens to fire — but no Stop hook can fire because no wake ever
    // landed. Chicken-and-egg, observed live on runic (#793 body).
    //
    // Fix: probe the pane right here. If the prompt is visible AND no
    // picker/transient is up, claude is at the prompt → seed idle-since
    // to now. The bus is the SSOT (`readIdleSinceMs` checks it first);
    // the wake gate unblocks on the next tick.
    refreshPaneMarkers();
    if (sd && readIdleSinceMs(sd) === null && getIpcState().paneReady === true) {
        // #881 — TurnController acteur : SESSION_START transitionne
        // unknown→no_turn (ou no_turn→no_turn reenter), bridge écrit ipc.idleSinceMs.
        getTurnService().sessionStart(Date.now());
        log("boot: pane is at prompt → seeded idle-since (via TurnController)");
    }
    // #628 david `mquuep` — WakeBus : façade typed sur le canal SSE
    // daemon→loop. Le timer souscrit aux events ; le bus gère le
    // throttle reconnect (5s) en interne. Future consumers (hooks,
    // MCP, fake-claude tests) peuvent subscribe via le même bus sans
    // re-créer un EventSource.
    const wakeBus = new WakeBus(client());
    wakeBus.on("hello", (h) => {
        setIpcLastSseEventAtMs(Date.now());
        setIpcSseConnected(true);
        log(`SSE hello: unread=${h.unread}`);
        // #1033 — aiball connection established (boot OR reconnect) : refresh the
        // bar counters eagerly so `o:N b:N e:N` appears as soon as we can talk to
        // the daemon, instead of waiting for the first heartbeat (~interval).
        void refreshCounters();
    });
    wakeBus.on("control", (c) => {
        setIpcLastSseEventAtMs(Date.now());
        setIpcSseConnected(true);
        if (c.action === "kill") cleanShutdown("sse:control:kill");
        // #451: operator-supplied RAW prompt → inject it into the Claude
        // session exactly like a wake (sendKeys sets the wake-in-flight +
        // coalesce markers so the timer doesn't auto-wake on top of it).
        else if (c.action === "prompt" && typeof c.text === "string") {
            const preview = c.text.length > 80 ? c.text.slice(0, 80) + "…" : c.text;
            log(`SSE control: prompt injection (${c.text.length} chars): ${preview}`);
            void sendKeys(c.text);
        }
        else log(`SSE control ignored (unknown action): ${JSON.stringify(c)}`);
    });
    wakeBus.on("ping", (p) => {
        setIpcLastSseEventAtMs(Date.now());
        setIpcSseConnected(true);
        const panic = p.intent === "panic";
        log(`SSE ping received: ${JSON.stringify(p)} → tryWake${panic ? " (panic)" : ""}`);
        // #816 david — instant counter refresh on SSE ping (else the bar's
        // `e:N` only repaints every ~30s on the heartbeat). #1033 — factored
        // into `refreshCounters()`. Fire-and-forget : not on the critical path.
        void refreshCounters();
        // #999 — model (a) : an SSE event does NOT fire a wake directly.
        // It records the payload as the pending hint ; the single drain
        // driver (`turn:settled`, the 10s tempo) picks it up on its next
        // tick (≤ tempo) and renders it comment-centric via the eventHint
        // path. This removes the "SSE fires direct" path that raced the
        // FIFO and fell to the backlog "Triage" branch (#999). PANIC is
        // the one exception : it stays immediate (rare + urgent).
        if (panic) {
            void tryWake("sse:ping:panic", false, p, true).then((fired) => {
                if (fired) return;
                const defer = readBusyDefer(sd!);
                if (defer && defer.activeMs > 0) {
                    setTimeout(() => {
                        void tryWake("sse:retry:panic", false, p, true);
                    }, defer.activeMs + 100);
                }
            });
        } else {
            pendingWakeHint = p;
            log(`SSE ping recorded as pending hint — drains on next turn:settled (≤${wakeTempoSec}s tempo)`);
        }
    });
    wakeBus.on("error", (e) => {
        setIpcSseConnected(false);
        log(`SSE error: ${e.message ?? String(e)} — will reconnect on next heartbeat`);
    });
    wakeBus.connect();
    log("SSE subscribed");
    // #B.148 bug: SSE only fires on NEW pings — existing unread at
    // boot would never trigger a wake until a fresh ping arrives.
    // Immediate tryWake covers the case where pings already exist
    // when the loop spawns (e.g. claude --resume scenario, or a
    // crashed-and-restarted loop).
    await tryWake("startup");
    // #868 david `<chat>` : the `settleBoot` BOOT_GRACE_MS (60s) safety
    // cap is gone. With the modern watchers (PaneWatcher etc.), the pane
    // watcher detects the prompt → no more deadline push → BootMachine
    // acteur seals on `DEADLINE_REACHED` (#872 Phase 3). settleBoot was
    // redundant : skipped when bootComplete was already true (= happy
    // case), deferred +60s on stretches (= also happy), force-sealed only
    // in the rare degenerate "claude hung without rendering its prompt"
    // case. If genuinely hung → the bar now stays yellow indefinitely
    // (= honest visual signal vs a
    // fake seal that flipped the bar green over a stuck claude).
    // #264: near-live human-typing detection poll (bicolor bar chip).
    // Independent of the wake heartbeat — fast cadence so the chip
    // tracks typing closely. Fail-safe (detectHumanTyping never throws).
    setInterval(detectHumanTyping, HUMAN_POLL_MS);
    // #783 phase 3 + 5 — fast watchdog at 2s. Two responsibilities:
    //   - tmux liveness: orphaned timer collapses within seconds of
    //     pane death (covers the case where the bash trap didn't run —
    //     pane killed externally, OS reaping on user logout, kill -9 of
    //     the wrapper). Calls cleanShutdown for the state-dir sweep.
    //   - SHA mismatch: tsx-watch may hold cached modules even after a
    //     code change (today's tryPanic-still-firing repro). The
    //     existing `selfReloadIfStale()` runs only post-heartbeat and
    //     only when claude is idle; if a stale wake keeps claude busy
    //     it's never reached. Running the SHA check on the watchdog
    //     cadence forces a full process respawn within 2s of any
    //     install-root SHA change, regardless of claude state.
    const watchdog = setInterval(() => {
        if (!tmuxAlive()) {
            clearInterval(watchdog);
            cleanShutdown("watchdog:tmux-gone");
            return;
        }
        selfReloadIfStale();
    }, 2000);

    // #627 — view-push loop. The timer owns the LoopState rules ;
    // here we watch the state-dir markers and push the recomputed
    // view to the proxy whenever it changes (or once a second, to
    // tick the AFK 10m countdown). The proxy paints from the pushed
    // view ; its local rules are bootstrap fallback only.
    //
    // Architecture (david `fdzg4e`) : timer ↔ proxy IPC via a
    // dedicated UDS, persistent connection, newline-delimited JSON.
    // The pusher reconnects transparently if the socket drops
    // (proxy reload, etc.). #730 step 1 : the path is now the shared
    // `loop.sock` (the timer ws server multiplexes future kinds on
    // the same socket — view today, proxyEvent + inject upcoming).
    // #630 david `d59zge` : LoopStateBus owns the prev-view + emits
    // typed events on transitions. The push-to-proxy hook listens to
    // `transition` (any change) and forwards via the existing pusher.
    // Other consumers can subscribe to specific events (afkArmed10m,
    // pickerOpened, …) for log decoration or future reactive painters
    // without re-implementing the diff. #872 Phase 3 — bootEnded/
    // bootStarted retirés (BootMachine acteur, cf. boot-machine.ts).
    // #730 step 2 — single ws server on `loop.sock` handles both
    // outbound view broadcasts (timer → proxy) and inbound proxyEvent
    // dispatch (proxy → timer). The dispatcher (`proxy-event-dispatcher.ts`)
    // is unchanged — it still sees the legacy event shape, the wrap is
    // unwrapped at the server boundary.
    const loopServer = createLoopServer(loopSockPath(sd!), {
        onProxyEvent: (event) => {
            // #1040 — reload hotkey (Ctrl+N by default) : the proxy detects the
            // key, consumes it, and emits {event:"reload"}. Re-exec the timer on
            // the SAME path as the SHA-stale auto-trigger (bypassing the
            // staleness check = an on-demand manual reload). respawnTimer exits,
            // so this is terminal — handle before the normal dispatch.
            if (event.event === "reload") {
                log("proxy-event: reload hotkey → respawning timer");
                respawnTimer("reload hotkey");
                return;
            }
            const verdict = dispatchProxyEvent(sd!, event);
            log(formatVerdictLogLine(verdict));
        },
        // #1039 — IPC link state → BarRenderer paints RED when down. The error
        // signal is a PING THAT FAILS (david `<chat>`) : `onClientStale` fires
        // only when the heartbeat ping went unanswered for the full 30s window
        // (peer confirmed dead) — debounced by design, no flicker. A connect
        // proves the link alive again (GREEN). Graceful closes (one-shot hooks)
        // are normal churn → ignored. onConnect also drains the offload (a
        // boot-drain (drainOffloadIntoLog at mainSse start) already replays
        // anything buffered while the timer was down ; no per-connect drain
        // (hooks connect every turn → would be noisy for no gain).
        onClientConnect: () => {
            // (Re)connected → cancel any pending RED grace and clear the
            // link-down overlay (back to normal colours ; there is no "green").
            log("loop.sock: client connected — IPC link OK (clear RED)");
            cancelLinkDownGrace();
            setIpcLinkDown(false);
        },
        onClientStale: () => {
            // #1039 david — don't flash RED immediately : a peer that went
            // stale but reconnects within the grace window must stay GREEN.
            // Arm the 10s grace ; onClientConnect cancels it.
            log(`loop.sock: peer went STALE — ${LINK_DOWN_GRACE_MS / 1000}s grace before bar RED`);
            armLinkDownGrace();
        },
        // #943 — `cmdReload` (external claude-loop CLI) round-trips this
        // BEFORE SIGKILL'ing us, so the new spawn restores exact XState
        // (AFK wait_inf survives reload). Symmetric to
        // `selfReloadIfStale` which captures the same 5 snapshots
        // in-process. Returns the serialized JSON string that the new
        // child sets as `CL_RESPAWN_STATE` env var.
        onGetSnapshots: () => {
            try {
                return serializeRespawnSnapshots({
                    boot: bootActor ? bootActor.getPersistedSnapshot() : undefined,
                    afk: getAfkService().getActor().getPersistedSnapshot(),
                    wake: getWakeService().getActor().getPersistedSnapshot(),
                    typing: getTypingService().getActor().getPersistedSnapshot(),
                    idle: getTurnService().getActor().getPersistedSnapshot(),
                });
            } catch (e) {
                log(`onGetSnapshots: capture failed (${(e as Error).message ?? String(e)})`);
                return null;
            }
        },
        // #944 — out-of-process subprocess (stop-hook, session-start-hook)
        // ships its pre-formatted log lines here. We append them to the
        // timer's stdout (= the unified loop log via the launcher's
        // redirect) so `tail -f loop.log` sees everything in one place,
        // chronologically interleaved. The line is already terminated by
        // \n by createLogger (cf. `src/log.ts:83`).
        onLogLine: (line) => process.stdout.write(line),
    });
    process.on("exit", () => loopServer.close());
    // #862 Slice 5 — `installHookBarSubscriber` retiré. La transition
    // UserPromptSubmit → BUSY est dérivée par le BarRenderer depuis
    // `paneBusy` (= pane watcher détecte busy → setIpcPaneBusy(true) →
    // BarRenderer recompute → bg busy peint). Plus de wiring explicite.
    // #727 V1 Slice B — mirror hook events into the in-memory IPC state.
    // The dispatcher already emits SessionStart / Stop / UserPromptSubmit
    // on the HookService ; this subscriber translates them into the
    // bootComplete / idleSince fields that `readLoopStateInput` checks
    // first, ahead of the marker-file fallback. Files keep being written
    // by the hooks for cross-process readers (cli inspect, fallback) —
    // Slice B-3 stops the hook writes once we trust the in-memory side.
    // #893 Slice C+D — consumer migré direct vers hookWatcher.on. Pas
    // de bridge HookService nécessaire (= proxy-event-dispatcher emit
    // direct vers HookWatcher maintenant). HookService droppé.
    const hookWatcher = getHookWatcher();
    hookWatcher.on("hook:session_start", (ev) => {
        // #822 david `etned7` — do NOT eagerly set bootComplete on
        // every SessionStart event. #872 Phase 3 — l'unique autorité de
        // sealing est désormais le BootMachine acteur. Les pickers +
        // idleSince still propagate ici so the wake gate sees fresh
        // per-hook input. #881 — `setIpcIdleSince` délégué au TurnController.
        getTurnService().sessionStart(ev.atMs);
        if (typeof ev.pickerSession === "boolean") {
            setIpcResumeSessionPicker(ev.pickerSession);
            if (sd) setResumeSessionPicker(sd, ev.pickerSession);
        }
        if (typeof ev.pickerMode === "boolean") {
            setIpcResumeModePicker(ev.pickerMode);
            if (sd) setResumeModePicker(sd, ev.pickerMode);
        }
    });
    hookWatcher.on("hook:stop", (ev) => {
        // Slice B-2 — busy-defer expiry pinné in-memory quand le hook
        // l'envoie (pane busy at turn end). Soit timestamp absolu = defer
        // le gate, soit null explicite = clear defer. Stop event = idle
        // confirmed. #881 — `setIpcIdleSince` délégué à TurnController.
        getTurnService().turnEnded(ev.atMs);
        if (ev.busyDeferUntilMs !== undefined) {
            if (ev.busyDeferUntilMs === null) {
                setIpcBusyDeferUntil(null);
            } else if (sd) {
                const delta = ev.busyDeferUntilMs - Date.now();
                if (delta > 0) armBusyDefer(sd, delta);
                else setIpcBusyDeferUntil(ev.busyDeferUntilMs);
            } else {
                setIpcBusyDeferUntil(ev.busyDeferUntilMs);
            }
        }
    });
    hookWatcher.on("hook:user_prompt_submit", (ev) => {
        // #898 — signal d'activité pour SanityController (reset stale clock).
        getSanityService().ticketActivity(ev.atMs);
        if (ev.fromAutoWake) return;
        // A real human submission flips claude back to busy ; an
        // auto-wake submission is the loop talking to itself.
        // #881 — délégué à TurnController via TURN_STARTED. Si TurnController
        // est déjà in_turn (Stop hook précédent perdu), le primary SM auto-
        // self-heal via TURN_STARTED en in_turn → emit turn:ended + reenter
        // (cf. turn-machine.ts #898 david `<chat>` self-heal).
        getTurnService().turnStarted(ev.atMs);
    });
    // #840 `4z59jt` — plus de fichier `afk`. AfkService est piloté
    // exclusivement via les helpers *ViaService (state.ts armAfk*),
    // toujours en mémoire. Pas de watcher à armer.
    // #962 — `@cl_afk_state` retiré ; le statut AFK dynamique vit
    // maintenant dans le glyph `웃` à la fin de la zone claude
    // (`@cl_afk_glyph`, peint par BarRenderer via `afkGlyphChunk`).
    // Status-right utilise un literal statique `AFK:F9`.
    // #862 Slice 1 — BarRenderer pur observer. Souscrit à `onIpcChanged`,
    // debounce 50ms, diff vs son lastSnapshot interne. Slice 1 ne paint
    // PAS tmux — il log les diffs via `logBarPaint` (writer=`observer:*`)
    // pour valider que le snapshot computed matche les paints actuels.
    // Slice 3 flippera en writer effectif (= les setTmuxStatus legacy
    // deviennent no-op à ce moment).
    const barRenderer = new BarRenderer(sd!, name!);
    barRenderer.start();
    process.on("exit", () => barRenderer.stop());
    // #629 — fast probe 1s pendant boot. Le BootMachine acteur drive
    // l'arming : on arme au démarrage si on est en booting (= cas normal,
    // pas un respawn handoff sealed), et le subscriber désarme à la
    // transition `sealed`. Pas de ré-armement — la machine est terminale.
    let fastProbeTimer: NodeJS.Timeout | null = null;
    // #647 david `db83ep` : memoize last painted info so we don't call
    // setTmuxStatus every second when nothing changed. Tmux set-option
    // is non-trivial (spawnSync). Null = "no info painted yet".
    let lastPaintedBootInfo: string | null = null;
    const armFastProbe = (): void => {
        if (fastProbeTimer) return;
        fastProbeTimer = setInterval(() => {
            try { refreshPaneMarkers(); } catch { /* best-effort */ }
            // #647 Slice 4 follow-up (david `a9njm5`) : pendant boot le
            // heartbeat 30s n'a pas tourné encore → setTmuxStatus du tick
            // ne fire pas. Faut peindre la barre depuis paneService ICI
            // pour que `[boot:picker:session]` etc. soit visible la
            // fenêtre entière du picker. Memoized (#647 david `db83ep`) :
            // only repaint when info changes (transitions only).
            try {
                const info = paneMarkerBarInfo();
                if (info !== lastPaintedBootInfo) {
                    // #862 Slice 5 — info suffix routé via ipc ; BarRenderer
                    // compose `[boot:<info>]` automatiquement.
                    setIpcStateTagInfo(info);
                    lastPaintedBootInfo = info;
                }
            } catch { /* best-effort */ }
        }, 1000);
        log("fast-probe: armed (1s cadence during boot)");
    };
    const disarmFastProbe = (): void => {
        if (!fastProbeTimer) return;
        clearInterval(fastProbeTimer);
        fastProbeTimer = null;
        log("fast-probe: disarmed (boot sealed)");
    };
    // #872 Phase 3 — `onFreshBootSeal` (= ancien `performBootSeal` inliné)
    //   regroupe les side-effects "première seal de la session" : armAfk
    //   --wait, reset du status tag, post-boot reminder, drain wake.
    //   Sur respawn handoff (bootComplete déjà true à boot), on saute
    //   ces effets (déjà émis par la session précédente). La détection
    //   se fait via `getIpcState().bootComplete !== true` dans le subscriber.
    const onFreshBootSeal = (): void => {
        // #639 david `pn97zf` — `--wait` (CL_WAIT=1) arms NOT AFK 10m at
        // boot exit so the bar reads `wait` yellow with a countdown : the
        // documented "managed mode" contract. `--no-wait` (CL_WAIT=0)
        // leaves AFK off — bar reads `loop` and auto-pings resume.
        if (cfg.wait) {
            armAfkViaService(sd!);
            log("bootMachine: sealed — --wait → armed NOT AFK 10m (via service)");
        }
        // #629 david `jf6efv` — flip the bar BG out of [boot] IMMEDIATELY.
        // #862 Slice 5 — setTmuxStatus(IDLE) retiré ; paneBusy=false suffit
        // pour que BarRenderer dérive idle au prochain compute.
        try { setIpcStateTagInfo(null); } catch { /* best-effort */ }
        // #1012 — le push du skill reminder + le drain ne se font PLUS au
        // boot:sealed : ils sont déplacés à l'entrée de la session live
        // (`startSessionIfReady`, = join C1∧C2). En mode dégradé (turn à cheval
        // sur le boot) on attend la fin du turn avant de pousser, au lieu de
        // collisionner avec la frappe / un turn en vol.
    };
    // #1012 david — JOIN de démarrage de la session live (cinématiques
    // parallèles boot ∥ turn). C1 = ¬(un turn a commencé pendant le boot et
    // n'est pas fini) ; DÉFAUT true. C2 = boot terminé (loop:start). La session
    // démarre quand C1 ∧ C2, déclenchée par celui qui finit en dernier. C1
    // défaut-true ⇒ un boot propre démarre la session au boot-end SANS dépendre
    // d'un Stop hook (corrige « barre idle mais aucun event »).
    let joinC1 = true;       // claude idle-ready (pas de turn à cheval sur le boot)
    let joinC2 = false;      // boot terminé (loop:start émis)
    let sessionLive = false;
    // #922 david `56sxsu` — un turn DÉMARRÉ pendant le boot (avant session-live)
    // est forcément un PROMPT HUMAIN : le WakeMachine est `gated` jusqu'à
    // BOOT_READY, donc aucun wake auto ne peut fire pendant cette fenêtre.
    // Sert à annuler le fallback skill (intention humaine déjà présente).
    let humanPromptedDuringBoot = false;
    // #922 david `56sxsu` — l'auto-prompt skill est un FALLBACK pour DÉMARRER
    // une session quand rien d'autre ne la pilote. On l'annule dès qu'il y a
    // une autre intention : (a) un humain a promptè (turn pendant le boot), OU
    // (b) `--wait` / hold NOT-AFK armé (humanPresentHold), OU une frappe en
    // cours. La « présence passive qui regarde » ne compte pas (pas de signal
    // fiable au fresh boot — david : « présence qui regarde ne veut rien dire »).
    const pushSessionBootstrapSkill = (): void => {
        if (postBootRemindersSent) return;
        postBootRemindersSent = true;
        try {
            const promptMap = mergePrompts(loadPromptsFromYaml(pingsPath(sd!)), {});
            const reminder = renderSlot(promptMap, "post_boot_skill_reminder", {}, "");
            if (reminder.length === 0) return;
            const typing = humanIsTyping(sd!);
            const present = humanPresentHold(sd!);
            if (shouldInjectBootstrapSkill({ typing, hold: present, humanPrompted: humanPromptedDuringBoot })) {
                log(`session:live bootstrap skill: injecting (${reminder.length} chars)`);
                void sendKeys(reminder);
            } else {
                log(`session:live bootstrap skill skipped (other intent: typing=${typing} hold=${present} humanPrompted=${humanPromptedDuringBoot})`);
            }
        } catch (e) {
            log(`session:live bootstrap skill load failed (ignored): ${String(e)}`);
        }
    };
    const startSessionIfReady = (): void => {
        if (sessionLive || !joinC1 || !joinC2) return;
        sessionLive = true;
        log("session:live — join(C1 ∧ C2) → loopStart + BOOT_READY + idle-seed + drain");
        setIpcLoopStart(true);
        getWakeService().getActor().send({ type: "BOOT_READY" });
        // À session-live, claude est idle PAR CONSTRUCTION (C1 true = aucun turn
        // en vol) → seed le marker idle si absent, pour que le gate wake passe
        // même si le Stop hook n'a jamais fired (#1012 — fix « no idle marker »).
        if (sd && readIdleSinceMs(sd) === null) setIpcIdleSince(Date.now());
        pushSessionBootstrapSkill();
        void tryWake("session-live-drain");
    };
    // #872 / #870 Phase 1+3 — XState BootMachine acteur unique propriétaire
    //   du sealing. Le subscriber pure-bridge : update `bootDeadlineMs`
    //   ipc (consumed by bar-renderer + isInBootGrace).
    //   Le consumer `bootActor.on("boot:sealed", …)` (#877 Slice A) réagit
    //   à la transition `booting → sealed` : disarm fast-probe, leave pane
    //   "boot" zone, et (si fresh seal, pas respawn) écrit `bootComplete`
    //   + side-effects via `onFreshBootSeal`. Le gate `wasComplete` (lu
    //   à l'init) discrimine respawn de fresh ; le `reason` ("deadline" |
    //   "hook") sur le payload du locus event aussi mais le gate ipc
    //   reste plus simple.
    {
        const input0 = readLoopStateInput(sd!);
        // #884 — restore depuis snapshot persisté si respawn.
        const bootSnap = consumePendingSnapshot("boot") as Snapshot<unknown> | undefined;
        bootActor = createActor(bootMachine, {
            input: {
                loopStartMs: input0.loopStartMs,
                bootMinMs: input0.bootMinMs,
            },
            snapshot: bootSnap,
        });
        // Pure ipcState bridge — fires on every snapshot change.
        bootActor.subscribe((snap) => {
            setIpcBootDeadlineMs(snap.context.deadlineMs);
            // #994/#1009 — mirror the live boot modules (within their remanence
            // window) to ipc so `inspect` can name a leaked/stuck module.
            setIpcBootActiveModules(liveBootModules(snap.context.moduleSeen, Date.now()));
        });
        // Locus event consumer — fires once on `booting → sealed`.
        bootActor.on("boot:sealed", (ev) => {
            disarmFastProbe();
            paneObs.leave("boot");
            if (getIpcState().bootComplete !== true) {
                log(`bootMachine: boot:sealed reason=${ev.reason} loopStartMs=${ev.loopStartMs} → setIpcBootComplete(true)`);
                setIpcBootComplete(true);
                onFreshBootSeal();
            } else {
                log(`bootMachine: boot:sealed reason=${ev.reason} (respawn handoff, side-effects skipped)`);
            }
        });
        // #848 david `<chat>` : `loop:start` = registre "green light", set
        // 10s après `boot:sealed` (= sealed.fresh → sealed.settled). Les
        // consumers qui veulent "boot vraiment fini" gate sur ce flag au
        // lieu de bootComplete.
        bootActor.on("loop:start", (ev) => {
            // #1012 — loop:start = C2 (boot terminé). Le démarrage effectif
            // (loopStart/BOOT_READY/drain/skill) est fait par le join quand
            // C1 ∧ C2 (cf. startSessionIfReady), pas directement ici.
            log(`bootMachine: loop:start loopStartMs=${ev.loopStartMs} → C2=true (join)`);
            joinC2 = true;
            startSessionIfReady();
        });
        bootActor.start();
        // #884 — pas de respawn snapshot = cold boot normal.
        // Si bootSnap fourni : la SM démarre déjà en `sealed` (= no-op).
        if (!bootSnap) armFastProbe();
    }
    // #1009 — Deadline pump (the ONLY boot timer now). Each second, seal if all
    // modules have fallen (`now >= deadline`, where deadline = max(lastSeen +
    // remanence)). While any module is still re-signalled its lastSeen keeps the
    // deadline ahead of now → no fire ; once they all stop, the frozen deadline
    // is reached → DEADLINE_REACHED → seal. The push manager is GONE — the decay
    // model needs no deadline-extension side-loop (re-signals do it via
    // MODULE_SEEN). Pure machine, single wall-clock timer here.
    const bootDeadlineTimer = setInterval(() => {
        if (!bootActor) return;
        const snap = bootActor.getSnapshot();
        if (snap.matches("sealed")) { clearInterval(bootDeadlineTimer); return; }
        if (Date.now() >= snap.context.deadlineMs) {
            bootActor.send({ type: "DEADLINE_REACHED" });
            clearInterval(bootDeadlineTimer);
        }
    }, 1000);
    process.on("exit", () => {
        clearInterval(bootDeadlineTimer);
        bootActor?.stop();
    });
    // AfkController XState actor wiring. Le subscriber pont l'état actor →
    //   ipcState (`afkMode`/`afkExpiryMs` committed + `dispAfkMode`/`dispAfkExpiryMs`
    //   instant chip). EXPIRY_REACHED est pumpé par un setInterval 1s quand le
    //   wait_10m countdown expire — match BootMachine pattern (machine pure +
    //   external pump). Respawn handoff : si ipc.afkMode déjà set au boot
    //   (cf. respawn block plus haut), on sync l'acteur via HARD_* events.
    //   See `docs/SM-NETWORK.md` for the bridge + pump pattern.
    {
        const afkSvc = getAfkService();
        const afkActor = afkSvc.getActor();
        // Respawn handoff sync : the actor starts in "off" but ipc may
        // already carry a wait_X mode from the handoff block. Send HARD_*
        // to align the actor (synchronously) before attaching the bridge,
        // so the first subscriber fire matches what's already in ipc.
        const respawnIpc = getIpcState();
        if (respawnIpc.afkMode === "wait_10m" && respawnIpc.afkExpiryMs !== null) {
            afkSvc.set10m(respawnIpc.afkExpiryMs);
            log(`afkMachine: respawn handoff wait_10m (expiry=${new Date(respawnIpc.afkExpiryMs).toISOString()})`);
        } else if (respawnIpc.afkMode === "wait_inf") {
            afkSvc.setInf();
            log("afkMachine: respawn handoff wait_inf");
        }
        // Bridge actor → ipcState. Runs on every snapshot (initial sync
        // delivery + every transition).
        afkActor.subscribe((snap) => {
            const ctx = snap.context;
            // Committed slice : what consumers (wake gate, isHumanPresentHold) read.
            setIpcAfk(ctx.afkMode, ctx.afkExpiryMs);
            // Display slice : what the chip reads. Null when in a committed
            // state (chip falls back to committed afkMode) ; set when in
            // pending_X (chip shows the upcoming mode for instant feedback).
            const v = snap.value;
            if (v === "pending_off") {
                setIpcDispAfk({ mode: "off", expiryMs: null, commitAtMs: 0 });
            } else if (v === "pending_10m") {
                setIpcDispAfk({ mode: "wait_10m", expiryMs: ctx.dispExpiryMs, commitAtMs: 0 });
            } else if (v === "pending_inf") {
                setIpcDispAfk({ mode: "wait_inf", expiryMs: null, commitAtMs: 0 });
            } else {
                setIpcDispAfk(null);
            }
        });
        // EXPIRY_REACHED pump : poll wall-clock, send when wait_10m crosses
        // its committed expiry. Machine is pure (no Date.now()), pump lives
        // here — same shape as bootDeadlineTimer.
        const afkExpiryTimer = setInterval(() => {
            const snap = afkActor.getSnapshot();
            if (snap.value !== "wait_10m") return;
            const exp = snap.context.afkExpiryMs;
            if (exp !== null && Date.now() >= exp) {
                afkActor.send({ type: "EXPIRY_REACHED" });
                log(`afkMachine: EXPIRY_REACHED (wait_10m expired at ${new Date(exp).toISOString()})`);
            }
        }, 1000);
        process.on("exit", () => { clearInterval(afkExpiryTimer); });
    }
    // #879 — WakeController XState actor wiring. Subscriber bridge =
    //   `actor.context.{wakeInFlightAtMs, lastWakeAtMs}` → ipcState
    //   (= consumers : stop-hook, bar diagnostics). Locus consumer =
    //   `wake:delivered` → markMessageSeen (the FIFO-head ping is acked
    //   the moment send-keys hits the pane). Pas de pump externe — les
    //   `after()` interne (inFlightTtl + coalesceWindow) gèrent le
    //   lifecycle. Respawn handoff non-applicable (no persisted wake
    //   state across reloads — chaque process commence en idle).
    {
        const wakeActor = getWakeService().getActor();
        wakeActor.subscribe((snap) => {
            setIpcWakeInFlightAtMs(snap.context.wakeInFlightAtMs);
            if (snap.context.lastWakeAtMs !== null) {
                setIpcLastWakeAtMs(snap.context.lastWakeAtMs);
            }
        });
        wakeActor.on("wake:delivered", (ev) => {
            log(`wakeMachine: wake:delivered phrase=${JSON.stringify(ev.phrase.slice(0, 60))} headMessageId=${ev.headMessageId}`);
            if (ev.headMessageId !== null) {
                void client().markMessageSeen(ev.headMessageId).catch(() => {});
            }
            // #898 — wake delivered = signal d'activité ticket (drain réussi).
            getSanityService().ticketActivity();
        });
        wakeActor.on("wake:cleared", (ev) => log(`wakeMachine: wake:cleared reason=${ev.reason}`));
        wakeActor.on("wake:cooldown_expired", () => log("wakeMachine: wake:cooldown_expired (idle)"));
        // Observability : audit complet du cycle wake (requested → in_flight
        // → delivered/cleared/cooldown). Sans ça, on ne voit que delivered et
        // cleared, et un wake skip mid-cycle est invisible.
        wakeActor.on("wake:requested", (ev) => log(`wakeMachine: wake:requested source=${ev.source} atMs=${ev.atMs}`));
        wakeActor.on("wake:in_flight_started", (ev) => log(`wakeMachine: wake:in_flight_started atMs=${ev.atMs}`));
    }
    // #880 — TypingController XState actor wiring. Subscriber bridge :
    //   `actor.context.lastKeystrokeMs` → `ipc.humanTypingAtMs` (= back-compat
    //   pour les consumers existants : bar word "stop", chip typing,
    //   stop-hook humanIsTyping/5s gate). Locus consumer : `typing:started`
    //   pour les logs (et future cross-controller chain vers AFK). Pas
    //   de pump externe — `after(ttlMs)` interne gère le retour idle.
    {
        const typingActor = getTypingService().getActor();
        typingActor.subscribe((snap) => {
            if (snap.context.lastKeystrokeMs !== null) {
                setIpcHumanTypingAtMs(snap.context.lastKeystrokeMs);
            }
        });
        typingActor.on("typing:started", (ev) => log(`typingMachine: typing:started atMs=${ev.atMs}`));
        typingActor.on("typing:ended", (ev) => log(`typingMachine: typing:ended lastKeystrokeMs=${ev.lastKeystrokeMs}`));
    }
    // #881 — TurnController XState actor wiring. Subscriber bridge :
    //   `actor.context.idleSinceMs` → `ipc.idleSinceMs` (= consumers :
    //   wake gate, drained-strategy, bar). Pas de pump externe — pure
    //   event-driven depuis HookService (SessionStart/Stop/UserPromptSubmit)
    //   + 2 manual triggers (tryWake pre-empt + boot-end fallback).
    {
        const turnActor = getTurnService().getActor();
        turnActor.subscribe((snap) => {
            setIpcIdleSince(snap.context.idleSinceMs);
            // #805 david : countdown bar segment. Gated sur bootComplete
            // (= ne pas afficher pendant le boot, le turn controller ne
            // doit trigger qu'après seal). #848 : gate sur `loopStart`
            // (= 10s après boot:sealed) au lieu de bootComplete pour
            // cohérence avec le handler turn:settled ci-dessous.
            const ctx = snap.context;
            const bootDone = getIpcState().loopStart;
            // #999 david `7dfxgf` (point 2) — only arm the `📨Ns` countdown
            // when there's actually something to drain : a pending SSE event,
            // OR a non-empty FIFO (events>0) / backlog (backlog>0). Nothing
            // pending + empty FIFO + empty backlog → no countdown (the drain
            // would no-op anyway). The cadence reflects the configured tempo.
            const c = getIpcState().counters;
            const somethingToDrain = pendingWakeHint !== undefined
                || (c?.events ?? 0) > 0
                || (c?.backlog ?? 0) > 0;
            const tempoMs = wakeTempoSec * 1000;
            if (bootDone && somethingToDrain && snap.matches("no_turn") && ctx.idleSinceMs !== null) {
                const isSettled = snap.matches({ no_turn: "settled" });
                const nextAt = isSettled
                    ? Date.now() + tempoMs
                    : ctx.idleSinceMs + tempoMs;
                setIpcNextWakeAt(nextAt);
            } else {
                setIpcNextWakeAt(null);
            }
        });
        turnActor.on("turn:no_turn_since", (ev) => {
            log(`turnMachine: turn:no_turn_since atMs=${ev.atMs} reason=${ev.reason}`);
            // #890 safety : si on entre en no_turn via SESSION_START (re-attach
            // sans Stop hook → claude crash / hook perdu), le latch
            // paneBusy était collé. On clear ici aussi.
            busyProofs = releaseBusyProofs(); // #1014
            if (sd) setPaneBusy(sd, false);
        });
        turnActor.on("turn:started", (ev) => {
            log(`turnMachine: turn:started atMs=${ev.atMs}`);
            // #999 — a new turn supersedes a stale pending SSE event (the
            // human is interacting ; the deferred hint would be outdated).
            pendingWakeHint = undefined;
            // #1012 — un turn qui commence AVANT la fin du boot (C2 pas encore
            // true) fait tomber C1 : claude n'est plus idle-ready, la session
            // attendra la fin de ce turn.
            // #922 — ce turn pré-session-live = un prompt HUMAIN (WakeMachine
            // gated → pas de wake auto possible) ⇒ annule le fallback skill.
            if (!joinC2) { joinC1 = false; humanPromptedDuringBoot = true; }
        });
        turnActor.on("turn:ended", (ev) => {
            log(`turnMachine: turn:ended atMs=${ev.atMs}`);
            // #890 david `ue6q3n` : clear le latch paneBusy au Stop hook —
            // pendant qu'on attendait, les transitions visible=false du
            // BusyWatcher étaient ignorées (cf. busyW.on("change") plus haut).
            // #1014 : le Stop hook est un release autoritaire du turn → vide les
            // preuves (sinon `esc`/`compacting` encore visibles re-armeraient).
            busyProofs = releaseBusyProofs();
            if (sd) setPaneBusy(sd, false);
            // #1012 — fin de turn → C1 revient true ; si C2 déjà true et la
            // session pas encore démarrée, le join la démarre maintenant.
            joinC1 = true;
            startSessionIfReady();
        });
        // #805 david : "si on est idle depuis plus de N secondes" → drain
        // la FIFO sans dépendre de SSE/heartbeat aléatoires. No-turn stable
        // = signal pour pousser tryWake.
        // #848 david `chkb5z` : aussi le trigger pour le standalone
        // post-boot inject (one-shot per session, jamais prepended à un
        // wake).
        turnActor.on("turn:settled", (ev) => {
            // #848 david `<chat>` : gate sur `loopStart` (= 10s après
            // boot:sealed) au lieu de bootComplete. Pendant les 10s [sealed
            // → loop:start], on laisse les "boot end" things fire mais les
            // wakes turn:settled spéculatifs attendent. Le post-boot inject
            // n'est plus géré ici (= sendKeys immédiat au boot:sealed,
            // cf. onFreshBootSeal).
            if (!getIpcState().loopStart) return;
            log(`turnMachine: turn:settled idleSinceMs=${ev.idleSinceMs} tempo=${wakeTempoSec}s`);
            // #890 safety : si paneBusy était encore latché true ici (pane
            // SM no_turn stable depuis 30s = forcément pas busy), clear le
            // latch. Garde-fou en cas de Stop hook perdu.
            if (sd && getIpcState().paneBusy === true) {
                log("turn:settled : clearing stale paneBusy latch");
                busyProofs = releaseBusyProofs(); // #1014
                setPaneBusy(sd, false);
            }
            // #999 model (a) — sole periodic drain driver. Consume any pending
            // SSE event so the wake renders comment-centric (eventHint path) ;
            // a bare tick (no pending) drains the FIFO / backlog normally.
            const hint = pendingWakeHint;
            pendingWakeHint = undefined;
            void tryWake("turn:settled", false, hint);
        });
    }
    // #866 Slice 1 — runtime parent watchdog. Reprobe la session tmux
    // toutes les 5s via la même fonction pure que la garde boot-time
    // (#859). Quand le parent est mort (loop killé, pane fermé, etc.),
    // le timer self-exit → plus de timer-survivant qui roule du vieux
    // code après un reload non-propre. Pisynth-aiball desync de ce
    // matin = cause directe (cf. #862 thread).
    const parentWatchdog = installParentTmuxWatchdog({
        muxCmd: MUX_CMD,
        sessionName: tname,
        intervalMs: 5000,
        onDead: () => {
            log(`runtime watchdog: tmux session '${tname}' is gone — timer self-exiting`);
            process.exit(0);
        },
    });
    process.on("exit", () => parentWatchdog.stop());
    const loopBus = new LoopStateBus();
    // #862 Slice 5 — `repaintAfkState` retiré ; BarRenderer reads
    // `afkStateChunkStr` chaque tick (1s safety + onIpcChanged events).
    loopBus.on("transition", (_prev, next) => {
        loopServer.pushView(next);
        // #629 (xyss9z) : trace which writer drove the @cl_human change.
        // The timer doesn't setOpt directly — the proxy does, after receiving
        // the pushed view — but the timer is the ORIGIN of the value.
        logBarPaint(sd, "loop.ts:bus.transition", next.presence);
    });
    // #872 Phase 3 — `performBootSeal` + `bootSealTimer` + `loopBus.on("bootEnded"/"bootStarted")`
    //   retirés. Le BootMachine acteur (cf. boot-machine.ts) est l'unique
    //   propriétaire du sealing : `bootActor.subscribe` côté actor block
    //   ci-dessus appelle `onFreshBootSeal` (= ancien `performBootSeal`
    //   inliné dans le subscriber) à la transition `sealed`.
    // #629 david `7zqtgf` — same drain trigger when AFK is cleared
    // (F9 from NOT AFK 10m/∞ back to AFK). The bar word goes
    // wait→loop ; any ping that came while the hold was active
    // should now fire.
    //
    // #749 Phase C, david `ar4nce` trigger #3 — when input-hot is
    // active at the moment of the toggle (the human just typed and
    // claude is about to react), defer the wake until input-hot
    // expires. Without this we'd inject the wake phrase right on top
    // of a prompt the human is still mid-typing (the AFK toggle
    // itself was a keystroke). One-shot : if AFK gets re-armed
    // before input-hot expires, the unsubscribe cancels the pending
    // wake (the human changed their mind).
    // #877 Slice A — AFK consumers migrent de `loopBus.on(...)` vers
    //   `afkActor.on(...)` (XState v5 emit pattern). Convention
    //   `<controller>:<event_name>` + payload typé. La sémantique drain
    //   reste identique : sur `afk:cleared`, fire wake (ou defer si
    //   input-hot ; cancel si re-armed pendant la fenêtre).
    {
        const afkActor = getAfkService().getActor();
        afkActor.on("afk:cleared", () => {
            const current = readLoopStateInput(sd!);
            if (isInputHot(current)) {
                log("afkMachine: afk:cleared — input-hot still active, deferring wake");
                let unsubInputHot: (() => void) | null = null;
                let unsubAfkRearm: { unsubscribe: () => void } | null = null;
                const cleanup = () => {
                    if (unsubInputHot) unsubInputHot();
                    unsubAfkRearm?.unsubscribe();
                    unsubInputHot = null;
                    unsubAfkRearm = null;
                };
                // #888 Slice B — migré de `loopBus.on("inputHot")` vers
                // l'emit direct de TypingController. Wrap subscription
                // into a () => void pour le cleanup uniforme.
                const sub = getTypingService().getActor().on("typing:ended", () => {
                    cleanup();
                    // #749 david — re-check AFK at fire time : the user may
                    // have re-armed it between afk:cleared and now.
                    const at = readLoopStateInput(sd!);
                    if (isHumanPresentHold(at)) {
                        log("afkMachine: input-hot expired post-afk:cleared but AFK was re-armed — skipping deferred wake");
                        return;
                    }
                    log("afkMachine: input-hot expired post-afk:cleared — firing deferred wake");
                    void tryWake("afk-cleared-drain (input-hot expired)");
                });
                unsubInputHot = () => sub.unsubscribe();
                // If user re-armed AFK before input-hot expired, cancel.
                unsubAfkRearm = afkActor.on("afk:armed_10m", () => {
                    log("afkMachine: AFK re-armed before input-hot expired, cancelling deferred wake");
                    cleanup();
                });
                return;
            }
            // #749 david — same sanity re-check on the immediate path.
            const afterEmit = readLoopStateInput(sd!);
            if (isHumanPresentHold(afterEmit)) {
                log("afkMachine: afk:cleared but AFK was re-armed before tryWake — skipping");
                return;
            }
            void tryWake("afk-cleared-drain");
        });
        // Log lines for AFK locus events (decorations).
        afkActor.on("afk:armed_10m", (ev) => log(`afkMachine: afk:armed_10m expiry=${new Date(ev.expiryMs).toISOString()} prevMode=${ev.prevMode}`));
        afkActor.on("afk:armed_inf", (ev) => log(`afkMachine: afk:armed_inf prevMode=${ev.prevMode}`));
        afkActor.on("afk:cleared", (ev) => log(`afkMachine: afk:cleared prevMode=${ev.prevMode} reason=${ev.reason}`));
    }
    // #845 Phase B + #872 Phase 3 — la zone "boot" du PaneObserver est
    //   pilotée par le BootMachine acteur (cf. bloc actor plus haut) :
    //   `paneObs.leave("boot")` au sealing (subscriber), `paneObs.enter("boot")`
    //   à module init si !respawn-handoff. Pas de ré-entrée — la machine
    //   est terminale.
    // #888 Slice C — migré de loopBus.on("pickerOpened/Closed") vers
    // les watchers PaneWatcher direct.
    pickerSessionW.on("begin", () => log("watcher: resume picker session opened"));
    pickerSessionW.on("end", () => log("watcher: resume picker session closed"));
    pickerModeW.on("begin", () => log("watcher: resume picker mode opened"));
    pickerModeW.on("end", () => log("watcher: resume picker mode closed"));
    // #888 Slice A — bus.busy log drop : couvert par turnMachine
    // turn:started/turn:ended logs déjà câblés.
    // #714 david `gftprc` — bar (status-bg + suffix paneInfo) was repainted
    // only at the 30s heartbeat. So even with the 1s refresh keeping
    // pane-busy / pane-compacting fresh, the user saw `[busy:compacting]`
    // appear up to 30s after typing /compact. Paint immediately on bus
    // transitions, memoized so we don't repaint when nothing changed.
    // `setTmuxStatus` spawns tmux set-option (~3ms), kept cheap via the
    // memo + transition-only firing.
    let lastPaintedPostBoot: string | null = null;
    // #821 david `8r6nr2` — single-source repaint en fond de panier : un
    // setInterval(1000) qui appelle paneMarkerBarInfo() + setTmuxStatus
    // si le memo `phase|paneInfo` change. Remplace le double-wiring
    // précédent (`loopBus.transition` + `PaneService.subscribeAny`) qui
    // était fragile (transitions ratées si LoopStateView ne change pas —
    // cas de paneCompacting qui ne flippe aucun champ de view). Memo
    // garantit qu'on ne fait qu'1 spawn tmux par changement réel ;
    // paneMarkerBarInfo() est un snapshot mémoire (~µs). Latence max
    // 1s sur un flip vs quasi-instantané avant ; trade accepté pour la
    // robustesse + simplicité.
    const repaintPaneInfo = (): void => {
        const view = loopBus.current();
        if (!view || view.inBootGrace) return;
        try {
            const paneInfo = paneMarkerBarInfo();
            // Memo key captures phase + paneInfo. Count refresh stays
            // heartbeat-driven (don't repaint on every tick just for that
            // — heartbeat owns the @cl_counts segment).
            const memoKey = `${view.phase}|${paneInfo ?? "-"}`;
            if (memoKey === lastPaintedPostBoot) return;
            if (paneInfo) {
                // #862 Slice 5 — substate via ipc, BarRenderer compose le tag.
                setIpcStateTagInfo(paneInfo);
            }
            // No-info path : let heartbeat repaint with fresh unread count.
            // Otherwise we'd race the count refresh + lose it.
            else { return; /* skip memo update so heartbeat re-paints with count */ }
            lastPaintedPostBoot = memoKey;
        } catch { /* best-effort */ }
    };
    setInterval(repaintPaneInfo, 1000);
    const pushViewIfChanged = (): void => {
        try {
            loopBus.update(readLoopStateInput(sd!));
            // #860 — stamp post-push so `claude-loop health` can flag
            // a stale ipc (timer alive but its bus loop has frozen).
            setIpcLastViewPushAtMs(Date.now());
        } catch { /* swallow — next tick retries */ }
    };
    // Debounced trigger : coalesce a burst of marker writes into a single
    // push (proxy typing branch writes 3 markers per keystroke).
    let viewPushTimer: NodeJS.Timeout | null = null;
    const schedulePush = (): void => {
        if (viewPushTimer) return;
        viewPushTimer = setTimeout(() => {
            viewPushTimer = null;
            pushViewIfChanged();
        }, 50);
    };
    // #856 Phase 1 — subscribe to the IPC bus so every `setIpc*` schedules
    // a push automatically. Replaces the legacy `fs.watch` on the state-dir
    // (the timer was watching its own writes post-#839, plus the watch had
    // race windows that left the bar word stuck on a stale state — #846).
    // The push is debounced 50ms ; a burst of setIpc* calls (proxy typing
    // branch hits 3 in a row) coalesces into one push.
    const unsubIpcChanged = onIpcChanged(schedulePush);
    process.on("exit", () => unsubIpcChanged());
    // Periodic tick : countdown ticks down second-by-second even with no
    // marker change ; push once a second so the AFK chunk reflects it.
    // Also acts as a safety net for any external write that bypassed the
    // ipc bus (= file shadow written outside the timer process, rare).
    setInterval(pushViewIfChanged, 1000);
    // AfkController acteur (`after(debounce)` interne) handles the F9
    // toggle commit — `commitDispAfkIfDue` setInterval retiré. Le pump
    // EXPIRY_REACHED vit dans le bloc AfkController plus haut.
    // #722 david — 2-rate pane-probe driven by `shouldPollFast(input)` via
    // the bus `pollFast` event. Default cadence is SLOW (~1s) ; when ANY
    // of {boot, busy, input-hot} flips true the probe re-arms to FAST
    // (~200ms) so transitions catch fast (sub-second `[busy:compacting]`
    // post-`/compact`, post-keystroke detection). Back to slow on exit.
    // Cost while slow ≈ 5 ms/s constant ; while fast ≈ 25 ms/s, bounded
    // by the gate semantics.
    const FAST_MS = Math.max(1, cfg.pane_probe_fast_ms);
    const SLOW_MS = Math.max(1, cfg.pane_probe_slow_ms);
    let paneProbeTimer: NodeJS.Timeout | null = null;
    let paneProbeRateMs = SLOW_MS;
    const armPaneProbe = (ms: number): void => {
        if (paneProbeTimer) clearInterval(paneProbeTimer);
        paneProbeTimer = setInterval(() => {
            try { refreshPaneMarkers(); } catch { /* best-effort */ }
        }, ms);
        paneProbeRateMs = ms;
    };
    armPaneProbe(SLOW_MS);
    loopBus.on("pollFast", (next) => {
        const target = next ? FAST_MS : SLOW_MS;
        if (target === paneProbeRateMs) return;
        const old = paneProbeRateMs;
        armPaneProbe(target);
        log(`pane-probe: rate ${old}→${target}ms (${next ? "fast" : "slow"})`);
    });
    process.on("exit", () => { if (paneProbeTimer) { clearInterval(paneProbeTimer); paneProbeTimer = null; } });
    // Send the initial view ASAP so the proxy paints from it instead of
    // its local bootstrap. The pusher queues until the socket is up.
    pushViewIfChanged();
    // #714 — `settledStatus` local var retired. The bar BG phase is now
    // read from `loopBus.current()?.phase` (single source : the state
    // machine, fed by `pushViewIfChanged` every second + on every marker
    // change). Before, two parallel signals could diverge during /compact
    // (settledStatus said busy, computePhase said idle — bug A on #712).
    while (tmuxAlive()) {
        // #B.205: when busy-defer is armed, cap the heartbeat sleep at
        // the defer deadline so the post-defer work-check happens
        // promptly. Without this, an `idle:wait` armed for 5s could
        // sit unchecked for up to `interval` seconds (default 30s) if
        // no SSE ping arrived in the gap — david: "c'est pas appelé
        // tout le temps. et il faudrait tester en interne si il y a
        // encore du travail à ce moment".
        const defer = readBusyDefer(sd!);
        const sleepMs = defer ? Math.min(interval * 1000, defer.activeMs) : interval * 1000;
        const sleptToDeferDeadline = defer !== null && sleepMs === defer.activeMs;
        await sleep(sleepMs);
        // #B.212 david: when the heartbeat sleep was capped at the
        // defer deadline, log the expiry so the log isn't silent
        // between "BUSY-DEFER armed" and the next event. Without this,
        // a 5s defer ending in a quiet window (no SSE ping, no work)
        // produced no log at deadline — looked like the loop forgot.
        if (sleptToDeferDeadline) {
            log(`busy-defer window expired (slept ${sleepMs}ms) — checking work`);
        }
        // Manual wake (claude-loop wake NAME): IPC slot via UDS marker,
        // fires même quand SSE silent.
        if (getIpcState().wakeRequestedAtMs !== null) {
            await tryWake("manual", true);
            continue;
        }
        // SSE-drop safety net: re-check the gate ourselves.
        if (!wakeBus.isConnected()) wakeBus.connect();
        // #999 model (a) — the single periodic drain driver is `turn:settled`
        // (the 10s tempo). The heartbeat no longer drains on every tick : it's
        // an ANTI-STUCK fallback only, firing when `turn:settled` isn't
        // scheduling a drain (`nextWakeAtMs === null` = turn-machine not in
        // idle-settled, e.g. a lost Stop hook left it wedged, OR nothing to
        // drain in which case this no-ops via the work gate). When turn:settled
        // owns the cadence, the heartbeat stays out of the wake path entirely.
        const woke = getIpcState().nextWakeAtMs === null
            ? await tryWake("heartbeat-fallback")
            : false;
        if (!woke && readIdleSinceMs(sd!) !== null) {
            // #251: idle + nothing to wake on = the safe lull to pick up
            // new code. Re-execs the timer in place if the source SHA
            // moved since boot (claude pane untouched). Never mid-turn
            // (idle-marker gates it), never when there's work (a wake
            // would have fired above → woke=true → this branch skipped).
            // Exits the process on reload, so it must come last here.
            selfReloadIfStale();
        }
        // #714 — bar phase = `loopBus.current()?.phase`. The pane markers
        // are refreshed every 1s by `pushViewIfChanged` (not here), so by
        // the time we hit this heartbeat tick the view is already at most
        // ~1s stale. No more `settledStatus` local var racing the file
        // marker (bug A on #712), no more inline write of `idle-marker`
        // by an inline probe (bug B on #712).
        const phase = loopBus.current()?.phase ?? "boot";
        // #800 9sy4t3 — refresh both the bar tag (state + optional phase
        // suffix like `[busy:compacting]`) and the COUNTERS segment
        // (`o:M b:B e:N`) on every heartbeat, in every state (incl boot).
        // david wants the 3 counts visible across [idle]/[boot]/[busy].
        // #831 hot-fix : revert #800 — comment_count cross-project était
        // le TOTAL de tous les comments approuvés sur tous les projets
        // (= 5592 sur l'instance david, visiblement WTF). Back to
        // pingsCount.unread en attendant un vrai backlog-scoped count
        // côté backend (follow-up #832).
        // Fail-open : individual fetch errors leave that counter null
        // (= absent from the bar segment).
        try {
            pushViewIfChanged();
            // #1033 — counters fetch factored into `refreshCounters()` (shared
            // with the SSE-ping + connection-`hello` paths). Awaited here so the
            // heartbeat tick stays sequential.
            await refreshCounters();
        } catch { /* counters segment stays as-is */ }
        if (phase !== "boot") {
            try {
                // #647 Slice 4 : pane-derived markers (screen-takeover or
                // error) trump count/user as bar info. #862 Slice 5 — info
                // routé via ipc, BarRenderer compose `[busy:<info>]`.
                const paneInfo = paneMarkerBarInfo();
                setIpcStateTagInfo(paneInfo);
            } catch { /* swallow — bar stays as-is */ }
        }
        // #B.177 B1: heartbeat push of current state to the daemon
        // so the consumers panel shows `[busy]`/`[idle]`/`[boot]` per
        // agent + an "offline" badge after the heartbeat goes stale.
        // Fire on EVERY tick (not just transitions) — the daemon
        // updates `state_updated_at` always, freshness signal for
        // the UI's offline detector.
        // #280 + #745 phase B — push live human-presence so the panel can
        // render `human` vs autonomous `loop` while the heartbeat is fresh.
        // The signal is now derived from the AFK SM only (NOT AFK 10m/∞ =
        // human present) instead of the deprecated user-grace.
        try {
            const human = humanIsTyping(sd!) || humanPresentHold(sd!);
            const humanWord = humanPresence(sd);
            await client().pushState(phase, human, humanWord, loopCwd, loopProject);
        } catch { /* daemon down or transient — next tick retries */ }
        // #636 david — pytest harnesses spawn the loop with CL_RUN_ONCE=1, wait
        // for the inspect JSON to settle, then exit. Break after the first full
        // heartbeat cycle. claude + tmux stay alive ; the test cleans them up.
        if (process.env[CL_ENV.RUN_ONCE] === "1") {
            log("CL_RUN_ONCE=1 — exiting after one heartbeat cycle");
            break;
        }
    }
    log("tmux session gone — timer exiting");
    wakeBus.close();
    // #714 — explicit process.exit so pending handles (setInterval, fs.watch,
    // UDS servers, hook subscribers, boot-grace setTimeout) don't keep the
    // dying timer alive. Without this, an orphan timer survives the tmux
    // teardown and its 60s boot-grace setTimeout later injects a phantom
    // `boot-settle` wake into whatever new tmux session bears the same
    // name — david's "ça bug sans arret" + repeated auto-kill.
    process.exit(0);
}

/**
 * Pre-#B.148 polling loop, kept for non-aiball check-cmds where SSE
 * doesn't apply.
 */
async function mainPoll(): Promise<void> {
    log(`timer started — polling mode (tick ${interval}s), check-cmd: ${checkCmd}`);
    // #B.225: same boot SHA log as mainSse — see comment there.
    const bootSha = installRootSha();
    if (bootSha) log(`timer source: install-root SHA ${bootSha.slice(0, 7)}`);
    // Same startup safety net as SSE mode (#B.148): drain any
    // pre-existing work right away instead of waiting `interval`s.
    await tryWake("startup");
    while (tmuxAlive()) {
        // #B.205: cap sleep at busy-defer deadline (see mainSse note).
        const defer = readBusyDefer(sd!);
        const sleepMs = defer ? Math.min(interval * 1000, defer.activeMs) : interval * 1000;
        const sleptToDeferDeadline = defer !== null && sleepMs === defer.activeMs;
        await sleep(sleepMs);
        if (sleptToDeferDeadline) {
            log(`busy-defer window expired (slept ${sleepMs}ms) — checking work`);
        }
        const manualWake = getIpcState().wakeRequestedAtMs !== null;
        const woke = await tryWake(manualWake ? "manual" : "check-cmd hit", manualWake);
        // #251: same idle-gated self-reload as mainSse — pick up moved
        // source only in the lull (no wake fired AND claude is idle).
        if (!woke && readIdleSinceMs(sd!) !== null) selfReloadIfStale();
    }
    log("tmux session gone — timer exiting");
    // #714 — same explicit exit as mainSse (handles pinned by signals,
    // fs.watch, etc. would otherwise keep this dead process alive).
    process.exit(0);
}

async function main(): Promise<void> {
    // #388: SIGHUP = hard self-restart. The timer can't rm+start itself inline
    // (rm kills its own tmux session AND this very pid mid-handler), so delegate
    // to a DETACHED `claude-loop restart <name>` that survives the teardown,
    // then exit. So `kill -HUP <timer_pid>` is the self-service hard restart.
    //
    // #407 (fiabiliser): the old handler `spawn(...); unref(); process.exit(0)`
    // exited IMMEDIATELY — racing the detached fork, which sometimes died with
    // the parent → loop left un-restarted (no timer). Now: (1) exit ONLY after
    // the child's `spawn` event (it really exists), (2) capture the restart's
    // output to a log OUTSIDE the rm'd state dir, so failures are visible.
    process.on("SIGHUP", () => {
        if (!name) { process.exit(0); }
        const logPath = join(STATE_ROOT, "restart.log");
        // #412: route restart.log through the level logger (tag=name →
        // `<ts> [name] LEVEL msg`); these are info-level lifecycle lines.
        const restartLog = createLogger({
            tag: name,
            write: (line) => { try { appendFileSync(logPath, line); } catch { /* nowhere */ } },
        });
        const log = (m: string): void => restartLog.info(m);
        try {
            const bin = join(installRoot(), "bin", "claude-loop");
            const out = openSync(logPath, "a"); // restart child's stdout+stderr → the log
            const child = spawn(bin, ["restart", name!], { detached: true, stdio: ["ignore", out, out] });
            child.unref();
            child.on("spawn", () => { log(`SIGHUP → restart child pid ${child.pid} spawned`); process.exit(0); });
            child.on("error", (e) => { log(`SIGHUP → restart spawn FAILED: ${String(e)}`); process.exit(1); });
            // Safety net: never hang the dying timer if neither event fires.
            setTimeout(() => { log("SIGHUP → restart child events timed out; exiting anyway"); process.exit(0); }, 3000);
        } catch (e) {
            log(`SIGHUP → restart threw: ${String(e)}`);
            process.exit(1);
        }
    });
    // #407: SIGUSR2 = soft reload — the signal mirror of `claude-loop reload`
    // (respawn the detached timer to repick timer.ts/state.ts; claude untouched).
    // Unified with the daemon so a signal means the SAME thing on both CLIs:
    // `kill -HUP` = hard restart, `kill -USR2` = soft reload. Like SIGHUP, the
    // timer can't reload ITSELF inline (cmdReload kills this very pid), so it
    // delegates to a DETACHED `claude-loop reload <name>` that survives, exiting
    // only once the child really spawned (same fiabilisation as the SIGHUP path).
    process.on("SIGUSR2", () => {
        if (!name) { process.exit(0); }
        const logPath = join(STATE_ROOT, "restart.log");
        // #412: route restart.log through the level logger (tag=name →
        // `<ts> [name] LEVEL msg`); these are info-level lifecycle lines.
        const restartLog = createLogger({
            tag: name,
            write: (line) => { try { appendFileSync(logPath, line); } catch { /* nowhere */ } },
        });
        const log = (m: string): void => restartLog.info(m);
        try {
            const bin = join(installRoot(), "bin", "claude-loop");
            const out = openSync(logPath, "a");
            const child = spawn(bin, ["reload", name!], { detached: true, stdio: ["ignore", out, out] });
            child.unref();
            child.on("spawn", () => { log(`SIGUSR2 → reload child pid ${child.pid} spawned`); process.exit(0); });
            child.on("error", (e) => { log(`SIGUSR2 → reload spawn FAILED: ${String(e)}`); process.exit(1); });
            setTimeout(() => { log("SIGUSR2 → reload child events timed out; exiting anyway"); process.exit(0); }, 3000);
        } catch (e) {
            log(`SIGUSR2 → reload threw: ${String(e)}`);
            process.exit(1);
        }
    });
    // #442: SIGTERM = clean STOP. Completes the signal convention HUP=restart /
    // USR2=reload / TERM=stop. Unlike HUP/USR2 (which delegate to a detached
    // re-spawn), stop just halts in place — kill tmux + exit, state dir kept.
    // The signal mirror of `claude-loop stop`; the remote SSE control:kill also
    // funnels into the same `cleanShutdown`.
    process.on("SIGTERM", () => cleanShutdown("SIGTERM"));
    // #866 Slice 3 — SIGINT (= Ctrl-C, ou un parent qui propage via
    // shell pgid) emprunte la même cleanShutdown que SIGTERM. Sans ça
    // le default node handler tue le process sans sweep state.
    process.on("SIGINT", () => cleanShutdown("SIGINT"));
    if (isInternalCheckCmd(checkCmd)) {
        await mainSse();
    } else {
        await mainPoll();
    }
}

main().catch((e) => {
    process.stderr.write(`[claude-loop:${name}] timer crashed: ${String(e)}\n`);
    process.exit(1);
});
