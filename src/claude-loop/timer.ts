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
 * Logs to stdout (the launcher redirects to $STATE_DIR/timer.log).
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
import { appendFileSync, existsSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import { createLogger } from "../log.js";
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
    afkActive,
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
    humanPresenceWord,
    logBarPaint,
    logPaneCapture,
    zenPath,
    readPlate,
    writePlate,
    envPath,
    timerLogPath,
    timerPidPath,
    type Plate,
    type WakeHint,
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
import { PromptWatcher, BusyWatcher, InterruptedWatcher } from "./pane-watchers/runtime-watchers.js";
import { ErrorWatcher } from "./pane-watchers/error-watcher.js";
import { armAfkViaService } from "./afk-service-sync.js";
import { getAfkService } from "./afk-service.js";
import { getWakeService } from "./wake-service.js";
import { getTypingService } from "./typing-service.js";
import { getIdleService } from "./idle-service.js";
import { probeParentTmuxAtBoot, installParentTmuxWatchdog, sweepSiblingTimers } from "./parent-liveness.js";
import {
    buildRespawnEnvFromSnapshots,
    consumePendingSnapshot,
    parseRespawnSnapshots,
    RESPAWN_STATE_ENV_VAR,
    setPendingRespawnSnapshots,
} from "./respawn-state.js";
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { bootMachine } from "./boot-machine.js";

let bootActor: ActorRefFrom<typeof bootMachine> | null = null;
import { getHookService } from "./hook-service.js";
import {
    getIpcState,
    onIpcChanged,
    setIpcBusyDeferUntil,
    setIpcAfk,
    setIpcDispAfk,
    setIpcBootComplete,
    setIpcLoopStart,
    setIpcHumanTypingAtMs,
    setIpcBootDeadlineMs,
    setIpcCounters,
    setIpcIdleSince,
    setIpcNextWakeAt,
    setIpcLastSseEventAtMs,
    setIpcSseConnected,
    setIpcLastWakeAtMs,
    setIpcResumeModePicker,
    setIpcLastViewPushAtMs,
    setIpcStateTagInfo,
    setIpcResumeSessionPicker,
    setIpcWakeInFlightAtMs,
    setIpcWakeRequested,
} from "./ipc-state.js";
import { computeLoopView, isAfkActive, isInputHot, LoopStateBus } from "./loop-state.js";
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
    // #442 sweep — drop the transient RUNTIME markers (stale `timer.pid`,
    // `idle-since`, `wake-*`, `human-typing`, `busy-defer-until`,
    // `inject.sock`, …) so the dead loop reads cleanly in `claude-loop list` and a
    // later signal can't chase a recycled pid. KEEP the durable start config +
    // history (plate/env/pings/timer.log) so `restart` replays. (B): the state dir
    // itself stays — `rm` is the halt + delete.
    if (sd) {
        const KEEP = new Set(["plate.json", "env", "pings.yaml", "timer.log"]);
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
try { writeFileSync(timerPidPath(sd!), `${process.pid}\n`); } catch { /* best effort — la cible kill resterait le wrapper */ }

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
// stdout → redirected to timer.log by the launcher). Existing calls map to
// `info` so default output is unchanged (now carrying the LEVEL token); use
// `logger.debug(…)` for new diagnostic lines (dropped at the default `info`).
// #B.198: ts stays at the head so `--log` can reorder as `<ts> [tag] body`.
const logger = createLogger({ tag: `claude-loop:${name}` });
function log(msg: string): void {
    logger.info(msg);
}

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
    const killed = sweepSiblingTimers(sd);
    if (killed.length > 0) {
        log(`startup: swept ${killed.length} sibling timer(s) bound to '${sd}': ${killed.join(", ")}`);
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
function capturePane(): string {
    try {
        const r = spawnSync(MUX_CMD, [
            "capture-pane", "-t", `${tname}.0`, "-p",
        ], { encoding: "utf8" });
        const text = r.stdout ?? "";
        logPaneCapture(sd, text);
        return text;
    } catch {
        return "";
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
    if (sha) {
        plate.started_at_sha = sha;
        try { writePlate(sd!, plate); } catch { /* best effort — fresh timer would just reload once more */ }
    }
    // #884 — capture les snapshots XState v5 des 5 controllers AVANT de
    // spawn le new process. Le NEW timer les restaure via
    // `setPendingRespawnSnapshots` au boot puis les service factories
    // les consomment. Pattern uniforme, drop les sync ad hoc HARD_*.
    const respawnEnv = buildRespawnEnvFromSnapshots({
        boot: bootActor ? bootActor.getPersistedSnapshot() : undefined,
        afk: getAfkService().getActor().getPersistedSnapshot(),
        wake: getWakeService().getActor().getPersistedSnapshot(),
        typing: getTypingService().getActor().getPersistedSnapshot(),
        idle: getIdleService().getActor().getPersistedSnapshot(),
    });
    const root = installRoot();
    const logFd = openSync(timerLogPath(sd!), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
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
    log("timer respawned (detached) — new child will record its own pid at boot");
    process.exit(0);
}

// #B.221: when the SSE hint carries a ticket_id, `buildWakePhrase`
// renders the directive template ("Handle ticket #X — comment #Y.")
// — already context-rich, no wrap needed. When there's no hint
// (heartbeat re-check, manual wake, SSE-drop safety net), we used to
// fall back to a bare culture phrase from `pickPingPhrase`. That left
// claude with the same no-context greeting bug session-start had.
// Now we route the no-hint path through `buildContextPhrase` so the
// wake carries unread/open counts + a drain directive too. Async
// because the wrap helper queries the daemon; tryWakeInner already
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
    if (hint?.ticket_id) {
        const me = process.env.AIBALL_AGENT;
        const ctx = await fetchWakeContext(hint, me);
        if (!ctx.stakeholder) {
            log(`wake-hint #${hint.ticket_id}${hint.comment_hashid ? ` (comment #${hint.comment_hashid})` : ""} not for me (${me}) — generic FIFO-pop phrase`);
        }
    }
    const result = await buildContextPhrase(
        client(),
        process.env.AIBALL_PROJECT ?? null,
        pingsPath(sd!),
    );
    // #848 david `chkb5z` — le post-boot reminder n'est PAS prepended.
    // Inject standalone via `idleActor.on("idle:settled")` ; pickPhrase
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
const errorW = new ErrorWatcher();
const paneObs = new PaneObserver();
paneObs.registerZone(new Zone("boot", [pickerSessionW, pickerModeW, resumingW, compactConfirmW]));
paneObs.registerZone(new Zone("runtime", [
    promptW, busyW, interruptedW, errorW, getCompactingDetector(),
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
// #883 Slice 2 — forward begin/end ALSO vers BootMachine.MODULE_STARTED/ENDED
// (edge events module-based). Le bootActor n'existe pas encore à module
// init, donc on l'accède via le getter au moment du fire.
function forwardModuleStarted(name: string): void {
    if (bootActor && !bootActor.getSnapshot().matches("sealed")) {
        bootActor.send({ type: "MODULE_STARTED", name });
    }
}
function forwardModuleEnded(name: string): void {
    if (bootActor && !bootActor.getSnapshot().matches("sealed")) {
        bootActor.send({ type: "MODULE_ENDED", name });
    }
}
if (sd) {
    pickerSessionW.on("change", (s) => { setResumeSessionPicker(sd, s.visible); refreshPaneReady(); });
    pickerSessionW.on("begin", () => forwardModuleStarted("resume_picker"));
    pickerSessionW.on("end", () => forwardModuleEnded("resume_picker"));
    pickerModeW.on("change", (s) => { setResumeModePicker(sd, s.visible); refreshPaneReady(); });
    pickerModeW.on("begin", () => forwardModuleStarted("resume_mode"));
    pickerModeW.on("end", () => forwardModuleEnded("resume_mode"));
    resumingW.on("change", (s) => { setResuming(sd, s.visible); refreshPaneReady(); });
    resumingW.on("begin", () => forwardModuleStarted("resuming"));
    resumingW.on("end", () => forwardModuleEnded("resuming"));
    compactConfirmW.on("change", () => refreshPaneReady());
    compactConfirmW.on("begin", () => forwardModuleStarted("compact_confirm"));
    compactConfirmW.on("end", () => forwardModuleEnded("compact_confirm"));
    promptW.on("change", () => refreshPaneReady());
    // #890 david `ue6q3n` : busy = LATCH depuis première vue de
    // "esc to interrupt" jusqu'au Stop hook. Quand david tape, sa saisie
    // pousse la regex hors de la fenêtre 5-lignes du footer → s.visible
    // devient false EN PLEIN turn. Latch : on ignore les transitions
    // visible=false, on attend `idle:turn_ended` (Stop hook) pour clear.
    busyW.on("change", (s) => { if (s.visible) setPaneBusy(sd, true); });
    interruptedW.on("change", (s) => setInterrupted(sd, s.visible));
    getCompactingDetector().on("change", (s) => { setCompacting(sd, s.active); refreshPaneReady(); });
    // CompactingDetector emits change(s) with `s.active` boolean ; forward begin/end via change diff.
    let _prevCompacting = false;
    getCompactingDetector().on("change", (s) => {
        if (s.active && !_prevCompacting) forwardModuleStarted("compacting");
        if (!s.active && _prevCompacting) forwardModuleEnded("compacting");
        _prevCompacting = s.active;
    });
}

function refreshPaneMarkers(): void {
    if (!sd) return;
    const paneText = capturePane();
    if (!paneText) return;
    const ipc = getIpcState();
    const isBoot = ipc.bootComplete !== true;
    // Single scan : watchers observe + emit events ; the subscribers
    // above call the legacy ipcState setters on every transition.
    paneObs.tick(paneText, { nowMs: Date.now(), isBoot });
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
    const errId = errorW.snapshot().errorId;
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
        spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, "Escape", "Escape"], { stdio: "ignore" });
        await sleep(500);
    }
    await injectWakePhrase(`${tname}.0`, phrase, () => {
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
// d'autres messages), on attend `idle:settled` après `boot:sealed` et
// on fire un sendKeys séparé avec juste le prompt. Garanties :
//   - one-shot par session (`postBootRemindersSent` flag)
//   - standalone (= jamais prepended à autre message)
//   - skip si claude jamais idle stable (= force injection évitée)
let postBootRemindersSent = false;
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
    // #881 — IdleController acteur : TURN_STARTED transitionne idle→busy
    // et clear idleSinceMs (bridge subscriber écrit setIpcIdleSince(null)).
    getIdleService().turnStarted(Date.now());
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
        // #881 — IdleController acteur : SESSION_START transitionne
        // unknown→idle (ou idle→idle reenter), bridge écrit ipc.idleSinceMs.
        getIdleService().sessionStart(Date.now());
        log("boot: pane is at prompt → seeded idle-since (via IdleController)");
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
        // #816 david — instant counter refresh on SSE ping. The bar's
        // `e:N` count was only repainted every 30s by the heartbeat,
        // so a fresh comment surfaced as a wake (<1s) but the counter
        // lagged. Refetch the 3 counts immediately and repaint @cl_counts.
        // Fire-and-forget : counter sync isn't on the critical path.
        void (async () => {
            try {
                // #818 y5ggkh : open + backlog scopés au projet du loop ;
                // events restent cross-project.
                // #831 hot-fix : revert #800 — comment_count cross-project
                // sommait TOUS les comments approuvés (= 5592 sur instance
                // david). Le vrai backlog-scoped count attend une vraie
                // implémentation backend (follow-up). En attendant : back
                // to pingsCount.unread comme pré-#800.
                const backlogQuery: Record<string, string | undefined> = { backlog: "1", limit: "500" };
                if (loopProject) backlogQuery.project = loopProject;
                const [pingsR, projectsR, backlogR] = await Promise.allSettled([
                    client().pingsCount() as Promise<{ unread?: number }>,
                    client().listProjectsDetailed() as Promise<Array<{ name: string; open_count?: number }>>,
                    client().listTickets(backlogQuery) as Promise<unknown[]>,
                ]);
                const events = pingsR.status === "fulfilled" ? (pingsR.value?.unread ?? 0) : null;
                const open = projectsR.status === "fulfilled" && Array.isArray(projectsR.value)
                    ? (loopProject
                        ? (projectsR.value.find((pr) => pr.name === loopProject)?.open_count ?? 0)
                        : projectsR.value.reduce((acc, pr) => acc + (pr.open_count ?? 0), 0))
                    : null;
                const backlog = backlogR.status === "fulfilled" && Array.isArray(backlogR.value)
                    ? backlogR.value.length
                    : null;
                // #835 david — when ALL three fetches fail simultaneously
                // (high HTTP load during busy phases, daemon hiccup, …),
                // every counter goes null → setTmuxCounters would clear
                // `@cl_counts` entirely and the bar's `o:N b:N e:N` segment
                // would disappear for the next ~5s until the next SSE/
                // heartbeat tick refetches. Skip the paint in that case
                // to preserve the last-known good snapshot — a stale
                // count is less confusing than a missing segment.
                if (events !== null || open !== null || backlog !== null) {
                    // #862 Slice 5 — setTmuxCounters legacy retiré ;
                    // setIpcCounters seul, BarRenderer peint.
                    setIpcCounters({ open, backlog, events });
                }
            } catch { /* counter sync best-effort */ }
        })();
        // Pass the SSE payload as a hint so the wake phrase can name
        // the concrete artifact instead of a random pop-culture line.
        const tag = panic ? "sse:ping:panic" : "sse:ping";
        void tryWake(tag, false, p, panic).then((fired) => {
            if (fired) return;
            // If the wake skipped while busy-defer is active, the
            // heartbeat may already be mid-sleep and won't re-check at
            // expiry (its cap is computed only on sleep entry). Schedule
            // a one-shot retry so the SSE event lands as soon as the
            // tempo opens up, not at the next 30s heartbeat tick.
            const defer = readBusyDefer(sd!);
            if (defer && defer.activeMs > 0) {
                setTimeout(() => {
                    void tryWake(panic ? "sse:retry:panic" : "sse:retry", false, p, panic);
                }, defer.activeMs + 100);
            }
        });
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
            const verdict = dispatchProxyEvent(sd!, event);
            log(formatVerdictLogLine(verdict));
        },
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
    const ipcStateSub = getHookService().subscribe((ev) => {
        if (ev.kind === "SessionStart") {
            // #822 david `etned7` — do NOT eagerly set bootComplete on
            // every SessionStart event. The hook fires the moment claude
            // boots, regardless of whether a picker / resuming / first-
            // compacting is still up ; setting bootComplete here sealed
            // the boot phase prematurely. #872 Phase 3 — l'unique
            // autorité de sealing est désormais le BootMachine acteur
            // (`DEADLINE_REACHED` after les pane watchers stoppent les
            // `WATCHER_TICK` push). The pickers + idleSince still
            // propagate here so the wake gate sees fresh per-hook input.
            // #881 — `setIpcIdleSince` délégué au IdleController acteur
            // (subscriber bridge dans le bloc IdleController plus bas).
            getIdleService().sessionStart(ev.at_ms);
            // Slice B-2 — propagate picker context if the hook detected it.
            // #839 Slice 3 (#766) — the timer (= single writer) ALSO writes
            // the picker shadow files. session-start-hook used to call
            // setResumeSessionPicker / setResumeModePicker / clearResumePickers
            // locally ; now it only emits, and we materialize the file here.
            if (typeof ev.picker_session === "boolean") {
                setIpcResumeSessionPicker(ev.picker_session);
                if (sd) setResumeSessionPicker(sd, ev.picker_session);
            }
            if (typeof ev.picker_mode === "boolean") {
                setIpcResumeModePicker(ev.picker_mode);
                if (sd) setResumeModePicker(sd, ev.picker_mode);
            }
            return;
        }
        if (ev.kind === "Stop") {
            // Slice B-2 — busy-defer expiry pinned in-memory when the
            // hook ships it (pane busy at turn end). Either an absolute
            // timestamp = defer the gate ; explicit null = clear defer.
            // The Stop hook only emits when claude reached the prompt —
            // a Stop event implies idle confirmed.
            // #881 — `setIpcIdleSince` délégué à IdleController via TURN_ENDED.
            getIdleService().turnEnded(ev.at_ms);
            if (ev.busy_defer_until_ms !== undefined) {
                // #840 `4z59jt` — IPC seul. armBusyDefer (state.ts) écrit
                // `setIpcBusyDeferUntil` derrière (idempotent preserve-max).
                if (ev.busy_defer_until_ms === null) {
                    setIpcBusyDeferUntil(null);
                } else if (sd) {
                    const delta = ev.busy_defer_until_ms - Date.now();
                    if (delta > 0) armBusyDefer(sd, delta);
                    else setIpcBusyDeferUntil(ev.busy_defer_until_ms);
                } else {
                    setIpcBusyDeferUntil(ev.busy_defer_until_ms);
                }
            }
            return;
        }
        if (ev.kind === "UserPromptSubmit" && !ev.from_auto_wake) {
            // A real human submission flips claude back to busy ; an
            // auto-wake submission is the loop talking to itself and
            // already preceded by setIpcIdleSince via the Stop event
            // that triggered the wake.
            // #881 — délégué à IdleController via TURN_STARTED.
            getIdleService().turnStarted(ev.at_ms);
            return;
        }
    });
    process.on("exit", () => ipcStateSub());
    // #840 `4z59jt` — plus de fichier `afk`. AfkService est piloté
    // exclusivement via les helpers *ViaService (state.ts armAfk*),
    // toujours en mémoire. Pas de watcher à armer.
    // #755 + #751 htwguc — paint the `@cl_afk_state` chip from the timer
    // ON EVERY PLATFORM. Pre-fix this block was gated to win32 because the
    // Unix Python proxy was supposed to own the chip ; but the proxy only
    // reads the committed `afk` file and is blind to `dispAfk` (in-memory
    // ipcState pending toggle, #751). On Linux that meant the F9 toggle
    // was invisible until commit. The timer paints with the DISPLAY value
    // (via `afkStateChunkStr` → `renderAfkChunk` → `dispAfk` fallback to
    // `afk`), the proxy paints from the committed file ; both write the
    // same option and converge. Repaint triggers : (a) `dispAfkChanged`
    // bus event (toggle / commit), (b) AfkService observable (commit
    // through *ViaService helpers), (c) 1s safety tick for the wait_10m
    // countdown. Diff-guarded so we only spend a tmux set-option when the
    // rendered string actually changes.
    // #862 Slice 5 — `repaintAfkState` + le `setInterval(1000)` retirés.
    // Le BarRenderer a son propre safety tick 1s qui catch le countdown
    // AFK chip (`@cl_afk_state`) automatiquement via `afkStateChunkStr`
    // dans `computeBarSnapshot`. Plus de double tick.
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
        // #848 david `<chat>` : sendKeys IMMÉDIAT au boot:sealed (= active
        // busy avec le prompt skill). Drop le stash+idle:settled (= ancien
        // mécanisme `chkb5z`). Le loop:start register fire 10s plus tard
        // (cf. bootActor.on("loop:start")) et gate les wakes idle:settled
        // ultérieurs.
        if (!postBootRemindersSent) {
            postBootRemindersSent = true;
            try {
                const promptMap = mergePrompts(
                    loadPromptsFromYaml(pingsPath(sd!)),
                    {},
                );
                const reminder = renderSlot(promptMap, "post_boot_skill_reminder", {}, "");
                if (reminder.length > 0) {
                    log(`post-boot reminder: injecting immediate (${reminder.length} chars)`);
                    void sendKeys(reminder);
                }
            } catch (e) {
                log(`post-boot reminder load failed (ignored): ${String(e)}`);
            }
        }
        // #629 david `7zqtgf` — drain stacked pings at boot exit.
        // #848 david `<chat>` : MAIS pas immédiat au boot:sealed — wait
        // pour loop:start (= +10s) pour que le sendKeys post-boot ait eu
        // le temps d'être consumed par claude. Le drain fire depuis
        // `bootActor.on("loop:start")` (cf. mainSse) au lieu de ici.
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
            log(`bootMachine: loop:start loopStartMs=${ev.loopStartMs} → setIpcLoopStart(true) + WakeController BOOT_READY + boot-ended-drain`);
            setIpcLoopStart(true);
            // #848 david `<chat>` : transitionne le WakeController de
            // `gated` → `idle` (= autorise les wakes). La SM le gate
            // jusqu'ici, plus de check imperatif.
            getWakeService().getActor().send({ type: "BOOT_READY" });
            // Drain les pings stackés MAINTENANT (= après les 10s buffer).
            void tryWake("boot-ended-drain");
        });
        bootActor.start();
        // #884 — pas de respawn snapshot = cold boot normal.
        // Si bootSnap fourni : la SM démarre déjà en `sealed` (= no-op).
        if (!bootSnap) armFastProbe();
    }
    // Pump DEADLINE_REACHED côté wall-clock — la machine reste pure (=
    // pas de timer interne), le side-effect setInterval vit côté wrapper.
    const bootDeadlineTimer = setInterval(() => {
        if (!bootActor) return;
        const snap = bootActor.getSnapshot();
        if (snap.matches("sealed")) { clearInterval(bootDeadlineTimer); return; }
        if (Date.now() >= snap.context.deadlineMs) {
            bootActor.send({ type: "DEADLINE_REACHED" });
            clearInterval(bootDeadlineTimer);
        }
    }, 1000);
    // #883 — push manager : tant qu'au moins un module est actif, on
    // envoie `PUSH { nowMs }` toutes les secondes pour pousser la
    // deadline. Le manager s'arme quand activeModules passe 0→>0 et
    // se désarme à >0→0. Re-arme si un module réapparaît tant qu'on
    // est en phase boot (= pas encore sealed). Sealed = stop final.
    let bootPushTimer: NodeJS.Timeout | null = null;
    const armBootPushTimer = (): void => {
        if (bootPushTimer) return;
        bootPushTimer = setInterval(() => {
            if (!bootActor) return;
            const snap = bootActor.getSnapshot();
            if (snap.matches("sealed") || snap.context.activeModules.size === 0) {
                // Defensive : la subscribe désarme déjà ; cette branche
                // catche le cas où on rate la transition (impossible en
                // théorie mais ceinture+bretelles).
                disarmBootPushTimer();
                return;
            }
            bootActor.send({ type: "PUSH", nowMs: Date.now() });
        }, 1000);
        log("bootMachine: push manager armed (activeModules > 0)");
    };
    const disarmBootPushTimer = (): void => {
        if (!bootPushTimer) return;
        clearInterval(bootPushTimer);
        bootPushTimer = null;
        log("bootMachine: push manager disarmed (activeModules empty)");
    };
    bootActor.subscribe((snap) => {
        if (snap.matches("sealed")) {
            disarmBootPushTimer();
            return;
        }
        if (snap.context.activeModules.size > 0) armBootPushTimer();
        else disarmBootPushTimer();
    });
    process.on("exit", () => {
        clearInterval(bootDeadlineTimer);
        disarmBootPushTimer();
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
            // Committed slice : what consumers (wake gate, isAfkActive) read.
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
    // #881 — IdleController XState actor wiring. Subscriber bridge :
    //   `actor.context.idleSinceMs` → `ipc.idleSinceMs` (= consumers :
    //   wake gate, drained-strategy, bar). Pas de pump externe — pure
    //   event-driven depuis HookService (SessionStart/Stop/UserPromptSubmit)
    //   + 2 manual triggers (tryWake pre-empt + boot-end fallback).
    {
        const idleActor = getIdleService().getActor();
        idleActor.subscribe((snap) => {
            setIpcIdleSince(snap.context.idleSinceMs);
            // #805 david : countdown bar segment. Gated sur bootComplete
            // (= ne pas afficher pendant le boot, l'idle controller ne
            // doit trigger qu'après seal). #848 : gate sur `loopStart`
            // (= 10s après boot:sealed) au lieu de bootComplete pour
            // cohérence avec le handler idle:settled ci-dessous.
            const ctx = snap.context;
            const bootDone = getIpcState().loopStart;
            if (bootDone && snap.matches("idle") && ctx.idleSinceMs !== null) {
                const isSettled = snap.matches({ idle: "settled" });
                const nextAt = isSettled
                    ? Date.now() + ctx.settleMs
                    : ctx.idleSinceMs + ctx.settleMs;
                setIpcNextWakeAt(nextAt);
            } else {
                setIpcNextWakeAt(null);
            }
        });
        idleActor.on("idle:since", (ev) => {
            log(`idleMachine: idle:since atMs=${ev.atMs} reason=${ev.reason}`);
            // #890 safety : si on entre en idle via SESSION_START (re-attach
            // sans Stop hook → claude crash / hook perdu), le latch
            // paneBusy était collé. On clear ici aussi.
            if (sd) setPaneBusy(sd, false);
        });
        idleActor.on("idle:turn_started", (ev) => log(`idleMachine: idle:turn_started atMs=${ev.atMs}`));
        idleActor.on("idle:turn_ended", (ev) => {
            log(`idleMachine: idle:turn_ended atMs=${ev.atMs}`);
            // #890 david `ue6q3n` : clear le latch paneBusy au Stop hook —
            // pendant qu'on attendait, les transitions visible=false du
            // BusyWatcher étaient ignorées (cf. busyW.on("change") plus haut).
            if (sd) setPaneBusy(sd, false);
        });
        // #805 david : "si on est idle depuis plus de N secondes" → drain
        // la FIFO sans dépendre de SSE/heartbeat aléatoires. Idle stable
        // = signal pour pousser tryWake.
        // #848 david `chkb5z` : aussi le trigger pour le standalone
        // post-boot inject (one-shot per session, jamais prepended à un
        // wake).
        idleActor.on("idle:settled", (ev) => {
            // #848 david `<chat>` : gate sur `loopStart` (= 10s après
            // boot:sealed) au lieu de bootComplete. Pendant les 10s [sealed
            // → loop:start], on laisse les "boot end" things fire mais les
            // wakes idle:settled spéculatifs attendent. Le post-boot inject
            // n'est plus géré ici (= sendKeys immédiat au boot:sealed,
            // cf. onFreshBootSeal).
            if (!getIpcState().loopStart) return;
            log(`idleMachine: idle:settled idleSinceMs=${ev.idleSinceMs} settleMs=${ev.settleMs}`);
            // #890 safety : si paneBusy était encore latché true ici (pane
            // SM idle stable depuis 30s = forcément pas busy), clear le
            // latch. Garde-fou en cas de Stop hook perdu.
            if (sd && getIpcState().paneBusy === true) {
                log("idle:settled : clearing stale paneBusy latch");
                setPaneBusy(sd, false);
            }
            void tryWake("idle:settled");
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
        logBarPaint(sd, "timer.ts:bus.transition", next.barWord);
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
                    if (isAfkActive(at)) {
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
            if (isAfkActive(afterEmit)) {
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
    // #888 Slice A — bus.busy log drop : couvert par idleMachine
    // turn_started/turn_ended logs déjà câblés.
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
        const woke = await tryWake("heartbeat");
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
            // #818 david `y5ggkh` : open + backlog scopés au projet du loop
            // (le loop est attaché à UN projet via AIBALL_PROJECT), events
            // restent cross-project (FIFO unread = agent scope, #800).
            const backlogQuery: Record<string, string | undefined> = { backlog: "1", limit: "500" };
            if (loopProject) backlogQuery.project = loopProject;
            const [pingsR, projectsR, backlogR] = await Promise.allSettled([
                client().pingsCount() as Promise<{ unread?: number }>,
                client().listProjectsDetailed() as Promise<Array<{ name: string; open_count?: number }>>,
                client().listTickets(backlogQuery) as Promise<unknown[]>,
            ]);
            const events = pingsR.status === "fulfilled" ? (pingsR.value?.unread ?? 0) : null;
            const open = projectsR.status === "fulfilled" && Array.isArray(projectsR.value)
                ? (loopProject
                    ? (projectsR.value.find((p) => p.name === loopProject)?.open_count ?? 0)
                    : projectsR.value.reduce((acc, p) => acc + (p.open_count ?? 0), 0))
                : null;
            const backlog = backlogR.status === "fulfilled"
                ? (Array.isArray(backlogR.value) ? backlogR.value.length : null)
                : null;
            // #835 david — preserve the last-known segment when all 3 fetches
            // fail (same rationale as the SSE-refresh path above). Without
            // this guard the segment cleared for ~5s whenever a busy phase
            // starved the HTTP client.
            if (events !== null || open !== null || backlog !== null) {
                // #862 Slice 5 — setIpcCounters seul, BarRenderer peint.
                setIpcCounters({ open, backlog, events });
            }
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
            const human = humanIsTyping(sd!) || afkActive(sd!);
            const humanWord = humanPresenceWord(sd);
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
