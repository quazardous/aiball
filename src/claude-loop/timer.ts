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
import { appendFileSync, existsSync, openSync, readdirSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { AiballClient } from "../client.js";
import { createLogger } from "../log.js";
import {
    isInternalCheckCmd,
    LOOP_STATUS,
    bootCompletePath,
    createProxyEventsServer,
    createViewPusher,
    proxyEventsSockPath,
    viewPushSockPath,
    paneShowsInterrupted,
    readLoopStateInput,
    clearResumePickers,
    setCompacting,
    setInterrupted,
    setPaneBusy,
    setPaneReady,
    setResumeModePicker,
    setResumeSessionPicker,
    setResuming,
    MUX_CMD,
    WAKE_COALESCE_WINDOW_MS,
    buildContextPhrase,
    buildWakePhrase,
    injectWakePhrase,
    checkHasWork,
    idleMarkerPath,
    humanTypingPath,
    userTookOverPath,
    humanIsTyping,
    humanPresent,
    injectSockPath,
    installRoot,
    installRootSha,
    STATE_ROOT,
    isLoopStale,
    isDuplicateWakeHint,
    lastWakeAtPath,
    pingsPath,
    readBusyDefer,
    recordOpenWakeCount,
    recordOpenWakeHash,
    readDrainedState,
    writeDrainedState,
    recordWakeHint,
    setTmuxStatus,
    snapshotPane,
    tmuxName,
    humanPresenceWord,
    logBarPaint,
    logPaneCapture,
    userIsTakingOver,
    wakeInFlightPath,
    wakeRequestedPath,
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
import { armErrorBackoff, matchPaneError, readErrorBackoff, resetErrorBackoff } from "./error-backoff.js";
import { syncPaneServiceFromMarkers } from "./pane-service-sync.js";
import { paneMarkerBarInfo } from "./pane-service.js";
import { armAfkViaService, watchAfkMarker } from "./afk-service-sync.js";
import { installHookBarSubscriber } from "./hook-bar-subscriber.js";
import { computeLoopView, LoopStateBus } from "./loop-state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";
import { WakeBus } from "./wake-bus.js";
import { CL_ENV } from "./env-vars.js";
import { stripMarkdown } from "./markdown-strip.js";

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
// .aiball.yaml, take the MAX of the two : a longer ask_grace widens
// the deferential window, never shrinks it. Default 600s.
const userGraceSec = Math.max(cfg.user_grace_seconds, cfg.ask_grace_seconds, 0);
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
    // #442 ménage — sweep the transient RUNTIME markers (stale `timer.pid`,
    // `idle-since`, `wake-*`, `user-took-over`, `human-typing`, `busy-defer-until`,
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
// #624 david `8pwvm3` : safety cap for settleBoot only (the
// `boot-complete` marker is the authoritative end-of-boot signal).
// Bumped from 60s → 300s so a slow resume picker never trips it.
const BOOT_GRACE_MS = Math.max(0, cfg.boot_grace_seconds) * 1000;
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
    const root = installRoot();
    const logFd = openSync(timerLogPath(sd!), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    const tsxBin = shQuote(join(root, "node_modules", ".bin", "tsx"));
    const child = spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd!))} && exec ${tsxBin} ${shQuote(timerScript)}`,
    ], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    writeFileSync(timerPidPath(sd!), String(child.pid) + "\n");
    log(`timer respawned — new pid ${child.pid}, exiting old`);
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
async function pickPhrase(hint?: WakeHint): Promise<string> {
    if (hint?.ticket_id) {
        const me = process.env.AIBALL_AGENT;
        const ctx = await fetchWakeContext(hint, me);
        if (ctx.stakeholder) {
            const enriched: WakeHint = ctx.commentBody
                ? { ...hint, comment_body: ctx.commentBody }
                : hint;
            return buildWakePhrase(enriched, pingsPath(sd!));
        }
        log(`wake-hint #${hint.ticket_id}${hint.comment_hashid ? ` (comment #${hint.comment_hashid})` : ""} not for me (${me}) — falling back to generic context phrase`);
    }
    return buildContextPhrase(
        client(),
        process.env.AIBALL_PROJECT ?? null,
        pingsPath(sd!),
    );
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

/**
 * Panic-interrupt path (#B.214). Triggered when an SSE ping arrives
 * with `intent === "panic"`. Unlike `tryWake`, this DOES NOT honor
 * any of the usual gates — busy-defer, capture-pane probe,
 * user-grace, and checkHasWork are all skipped. The human posted
 * a panic ticket precisely because they want claude interrupted
 * mid-turn, however busy claude appears to be.
 *
 * No rate-limit, no humans-only gate — david (#w47f9m):
 * "non (mais c'est pas un mécanisme qui doit etre plebicité)".
 * Moderation already gates message creation; double-gating here
 * would mostly trip legitimate cases. Comments on panic tickets
 * inherit the same path via SSE — there's no comment-level panic
 * because the UI doesn't surface it (david: "dans l'ui j'ai pas
 * le panic pour les commente . donc evoque le en commentaire dans
 * le code mais ticket only").
 *
 * Flow:
 *   1. Fetch the ticket body via the daemon — the SSE payload only
 *      carries ids, but the "complete message" david asked for is
 *      the body itself, formatted for visual urgency on the pane.
 *   2. Send double-Escape — Claude Code's interrupt-this-turn chord.
 *   3. Wait ~500ms for the prompt to repaint.
 *   4. Paste the wrapped body via a tmux paste-buffer (preserves
 *      newlines without the per-line Enter that `send-keys` would
 *      otherwise submit-on-first-newline). Fallback: single-line
 *      `send-keys` if `set-buffer` errored.
 *   5. Send Enter to submit.
 */
async function tryPanic(reason: string, hint: WakeHint): Promise<boolean> {
    if (!hint.ticket_id) {
        log(`skip panic (${reason}) — no ticket_id in hint`);
        return false;
    }
    let title = "";
    let body = "";
    let author = "(unknown)";
    try {
        const resp = await client().getTicket(hint.ticket_id, { summary: false }) as {
            ticket?: { title?: string | null; body?: string | null; by_agent?: string | null };
        };
        title = resp?.ticket?.title ?? "";
        body = resp?.ticket?.body ?? "";
        author = resp?.ticket?.by_agent ?? "(unknown)";
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        log(`panic (${reason}) — getTicket failed: ${m} — interrupting with ref only`);
    }
    const MAX_BODY = 4000;
    const trunc = body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "…[truncated]" : body;
    const msg = `PANIC: ${author} interrupted you on ticket #${hint.ticket_id} "${title}"\n\n${trunc}\n\nPoll #${hint.ticket_id} for the full thread.`;
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, "Escape", "Escape"], { stdio: "ignore" });
    await sleep(500);
    const bufName = `panic_${Date.now()}`;
    const setBuf = spawnSync(MUX_CMD, ["set-buffer", "-b", bufName, msg], { stdio: "ignore" });
    if (setBuf.status === 0) {
        spawnSync(MUX_CMD, ["paste-buffer", "-b", bufName, "-d", "-t", `${tname}.0`], { stdio: "ignore" });
    } else {
        const oneLine = msg.replace(/\n+/g, " ");
        spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, oneLine], { stdio: "ignore" });
    }
    await sleep(200);
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, "Enter"], { stdio: "ignore" });
    setTmuxStatus(name!, LOOP_STATUS.BUSY);
    log(`panic (${reason}) → interrupted + injected body (${msg.length} chars) for ticket #${hint.ticket_id} by ${author}`);
    return true;
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
function refreshPaneMarkers(): void {
    if (!sd) return;
    const paneText = capturePane();
    if (!paneText) return;
    const snap = snapshotPane(paneText);
    setPaneBusy(sd, snap.busy);
    // #647 david `6e2uzf` : le timer DOIT aussi détecter les pickers
    // (avant : seul le hook les détectait, et si hook rate/skip, fast-probe
    // n'avait rien à pousser → bar restait `[boot:session?]`). Mêmes regex
    // que session-start-hook.ts. Idempotent — setters no-op si état stable.
    const sessionPickerVisible = /Resume session\b/i.test(paneText) && /Space to preview/i.test(paneText);
    const modePickerVisible = /Resume from summary|Resume full session as-is|Don't ask me again/.test(paneText);
    // #647 david `4h75nk` : Resuming = post-picker, pre-prompt. Mutually
    // exclusive avec pickers (= already past them).
    const resumingVisible = /Resuming conversation/i.test(paneText)
        && !sessionPickerVisible && !modePickerVisible;
    setResumeSessionPicker(sd, sessionPickerVisible);
    setResumeModePicker(sd, modePickerVisible);
    setResuming(sd, resumingVisible);
    const pickerOrTransient = sessionPickerVisible || modePickerVisible || resumingVisible
        || /Compact this conversation|Compacting conversation/i.test(paneText);
    const promptVisible = /Claude Code v|❯ |^> /m.test(paneText);
    setPaneReady(sd, promptVisible && !pickerOrTransient);
    setCompacting(sd, snap.special === "compacting");
    setInterrupted(sd, paneShowsInterrupted(paneText));
    // #611 — error detection in heartbeat probe (parallel to stop-hook).
    const errId = matchPaneError(paneText);
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
async function sendKeys(phrase: string): Promise<void> {
    // #B.180: touch the wake-in-flight marker BEFORE send-keys so
    // UserPromptSubmit hook sees it when claude processes the wake
    // prompt and skips the user-took-over update. Without this, the
    // auto-wake would trigger the user-grace and lock subsequent
    // wakes for `CL_USER_GRACE_SEC` (default 300s).
    try {
        writeFileSync(wakeInFlightPath(sd!), new Date().toISOString() + "\n");
    } catch { /* ignore — UserPromptSubmit hook will fall through to user-grace path, suboptimal but safe */ }
    // #B.198 fix A: shared coalesce marker — Stop hook reads it to
    // suppress chain-fire bursts. Touched here so timer-driven
    // wakes also count toward the coalesce window.
    try {
        writeFileSync(lastWakeAtPath(sd!), new Date().toISOString() + "\n");
    } catch { /* ignore — coalesce will just fail open */ }
    lastSendAt = Date.now();
    await injectWakePhrase(`${tname}.0`, phrase);
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// #264 (david #c5fgha "ok B"): near-live detection of a human typing in
// the pane, via pane-diff. While claude is AT THE PROMPT (idle marker
// present = not mid-turn, no output streaming), poll the bottom of the
// pane; if it changes and the loop didn't just send-keys, a human is
// typing → refresh the human-typing marker (drives the bicolor bar chip
// in setTmuxStatus, and is a finer human-present signal than the
// submit-time user-took-over). Fail-safe: never throws — it must not
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
        if (existsSync(injectSockPath(sd!))) return;
        if (!existsSync(idleMarkerPath(sd!))) {
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
            try {
                writeFileSync(humanTypingPath(sd!), new Date().toISOString() + "\n");
                // #315/#345 A: typing also ARMS the user-grace (degraded-mode
                // parity with the proxy's touch_user_grace) so the bar does
                // stop → wait → loop. Armed even under --no-wait now: NO_WAIT
                // only disables the boot-grace, not yielding to a present human.
                writeFileSync(userTookOverPath(sd!), new Date().toISOString() + "\n");
            } catch { /* ignore — chip just won't show */ }
            log("human-typing detected (prompt area changed at idle)");
        }
        prevPaneTail = tail;
        // Edge-repaint the bicolor chip when it appears / clears (the
        // marker expires ~HUMAN_TYPING_TTL_SEC after the last keystroke).
        const showing = humanIsTyping(sd!);
        if (showing !== humanChipShown) {
            setTmuxStatus(name!, LOOP_STATUS.IDLE);
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
let tryWakeInFlight: Promise<boolean> | null = null;
async function tryWake(reason: string, manualWake = false, hint?: WakeHint): Promise<boolean> {
    if (tryWakeInFlight) {
        log(`skip wake (${reason}) — coalesce: another wake in flight`);
        return false;
    }
    tryWakeInFlight = tryWakeInner(reason, manualWake, hint).finally(() => {
        tryWakeInFlight = null;
    });
    return tryWakeInFlight;
}
async function tryWakeInner(reason: string, manualWake: boolean, hint?: WakeHint): Promise<boolean> {
    // #B.211 david: previously these two gates returned silently. The
    // log only showed `SSE ping received: ... → tryWake` and then
    // nothing for the same reason — david couldn't tell if the wake
    // was deferred, skipped, or actually fired. Log every skip with
    // a short reason so the log is self-explaining.
    if (!existsSync(idleMarkerPath(sd!))) {
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
            log(`skip wake (${reason}) — ${view.wakeSkipReason}`);
            return false;
        }
    }
    let gateOpenCount = 0;
    let gateHash: string | undefined;
    if (!manualWake) {
        const gate = await checkHasWork(
            checkCmd,
            client(),
            process.env.AIBALL_PROJECT ?? null,
            sd!,
        );
        gateOpenCount = gate.openCount;
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
    try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
    try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
    const phrase = await pickPhrase(hint);
    await sendKeys(phrase);
    // #B.198 david: "on cumule pas les event identique on les merge".
    // Persist the just-fired hint so subsequent SSE pings about the
    // same (ticket, comment) within `WAKE_COALESCE_WINDOW_MS` get
    // dropped at `onPing` (event-layer merge, no DB write).
    recordWakeHint(sd!, hint);
    // #379: record the landscape hash so the same set doesn't re-fire the
    // actionable leg (set-aware dedup, replaces the count watermark). Fall back
    // to the count watermark when the daemon supplied no hash (old version);
    // manual/legacy wakes leave both empty, which is fine.
    if (gateHash !== undefined) recordOpenWakeHash(sd!, gateHash);
    else if (gateOpenCount > 0) recordOpenWakeCount(sd!, gateOpenCount);
    setTmuxStatus(name!, LOOP_STATUS.BUSY);
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
    // #628 david `mquuep` — WakeBus : façade typed sur le canal SSE
    // daemon→loop. Le timer souscrit aux events ; le bus gère le
    // throttle reconnect (5s) en interne. Future consumers (hooks,
    // MCP, fake-claude tests) peuvent subscribe via le même bus sans
    // re-créer un EventSource.
    const wakeBus = new WakeBus(client());
    wakeBus.on("hello", (h) => log(`SSE hello: unread=${h.unread}`));
    wakeBus.on("control", (c) => {
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
        // #B.214: panic intent → interrupt-this-turn path, bypasses every
        // gate. Routed FIRST so the dup-hint coalesce below doesn't
        // swallow a panic that happens to share a (ticket, comment) tuple
        // with a recent normal wake. Rate-limit lives inside tryPanic
        // itself (1/min floor).
        if (p.intent === "panic") {
            log(`SSE ping received: ${JSON.stringify(p)} → tryPanic`);
            void tryPanic("sse:ping:panic", p);
            return;
        }
        // #B.198 david: "on cumule pas les event identique on les merge".
        // When N SSE pings about the same (ticket, comment) arrive in a
        // burst, only the first gets a wake ; the rest are dropped here
        // at the event boundary. Hook layer only — model is untouched.
        if (isDuplicateWakeHint(sd!, p, WAKE_COALESCE_WINDOW_MS)) {
            log(`SSE ping coalesced (dup hint <${WAKE_COALESCE_WINDOW_MS}ms): ${JSON.stringify(p)}`);
            return;
        }
        log(`SSE ping received: ${JSON.stringify(p)} → tryWake`);
        // #B.198 : pass the SSE payload as a hint so the wake phrase
        // names the concrete artifact (`Poll ticket #X — new comment #Y.`)
        // instead of a random pop-culture line.
        void tryWake("sse:ping", false, p);
    });
    wakeBus.on("error", (e) => {
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
    // #B.149: post-boot heuristic. Claude Code has no native "claude
    // is at prompt" signal — for `--resume` the SessionStart hook
    // fires BEFORE the user dismisses the picker, so we can't flip
    // status there. After BOOT_GRACE_MS the timer assumes claude has
    // settled, seeds the idle marker, and lets tryWake run normally
    // (will wake if SSE has been silent but there's actually work).
    // David: "on passe en idle avec un timeout court (60 sec par
    // defaut), si le user fait pas de prompt on lance l'auto ping,
    // si le user prompt on passe dasn la hook stop plus tard". User
    // input within the window updates user-took-over → tryWake's
    // user-grace gate skips the wake (the user is actively driving).
    // #B.180: yaml-configurable via `.aiball.yaml claude_loop.boot_grace_seconds`.
    // Env-var override read at boot (module-level `BOOT_GRACE_MS`); cli.ts
    // writes the resolved value.
    let bootSettled = false;
    const settleBoot = async () => {
        if (bootSettled) {
            // #B.228: defensive — settleBoot is only invoked once via
            // `setTimeout(BOOT_GRACE_MS)`, but log the re-entry guard
            // just in case a future caller adds another trigger.
            // (#714 retired the inline probe that used to flip this.)
            log("settleBoot skipped — bootSettled already true");
            return;
        }
        bootSettled = true;
        // #624 david `8pwvm3` : settleBoot is now the SAFETY path. If the
        // session-start-hook already signalled `setResumePicker(false)`,
        // boot-complete exists on disk → hook drove the transition (arm,
        // setTmuxStatus, …). settleBoot becomes a no-op so we don't
        // double-arm AFK at T+300s when the user has been working for
        // 5 min.
        if (existsSync(bootCompletePath(sd!))) {
            log("settleBoot skipped — boot-complete already signalled by session-start-hook");
            return;
        }
        log("boot grace elapsed (safety cap) — settling to idle/busy via check");
        // Hook never fired (--resume aborted, picker stuck past 5 min,
        // hook crashed). Drive the transition ourselves : sign boot-complete
        // so the state machine flips out of boot, seed idle-since, try a
        // wake. #629 david `y43etd` : DON'T auto-arm NOT AFK 10m anymore
        // — user-grace silently gates wakes if user typed pendant le
        // boot (typing → user-took-over → tryWake skip via user-grace).
        // Forcer le bar `wait` jaune à T+grace était intrusif ; bar reste
        // `loop` vert, user appuie F9 si besoin d'un hold visible.
        clearResumePickers(sd!);
        // #629 david `8wgq7f` — setResumePicker no longer seals bootComplete
        // (delegated to bus.on("bootEnded")). At the safety cap we WANT to
        // force the exit regardless of pending stretches (Resuming…, etc.)
        // because we've already burned bootGraceMs. Write it explicitly.
        try {
            writeFileSync(bootCompletePath(sd!), new Date().toISOString() + "\n");
        } catch { /* best-effort */ }
        // #639 david `pn97zf` — same wait-mode contract as the bus.on("bootEnded")
        // branch above. The bus path is the normal exit ; this safety cap
        // fires only when the bus didn't (paneReady never became true).
        // Keep the two paths consistent for the AFK arm.
        if (cfg.wait) {
            armAfkViaService(sd!);
            log("settleBoot: --wait → armed NOT AFK 10m (via service)");
        }
        // Seed idle-since so tryWake's gate passes; tryWake will
        // flip to busy if there's work or stay idle otherwise.
        try {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(idleMarkerPath(sd!), new Date().toISOString() + "\n");
        } catch { /* ignore */ }
        await tryWake("boot-settle");
        // tryWake removes idle-since on wake; if it didn't fire,
        // we still want the bar to read [idle] not [boot].
        if (existsSync(idleMarkerPath(sd!))) {
            // #B.228: log the bar flip so "barre reste jaune" repros
            // surface either this line (it WAS flipped) or its
            // absence (settleBoot didn't reach the idle-marker check).
            log("settleBoot: idle-marker present → setTmuxStatus(idle)");
            setTmuxStatus(name!, LOOP_STATUS.IDLE);
        } else {
            log("settleBoot: idle-marker missing after tryWake (wake fired?) — bar stays as set by wake path");
        }
    };
    setTimeout(() => { void settleBoot(); }, BOOT_GRACE_MS);
    // #264: near-live human-typing detection poll (bicolor bar chip).
    // Independent of the wake heartbeat — fast cadence so the chip
    // tracks typing closely. Fail-safe (detectHumanTyping never throws).
    setInterval(detectHumanTyping, HUMAN_POLL_MS);

    // #627 — view-push loop. The timer owns the LoopState rules ;
    // here we watch the state-dir markers and push the recomputed
    // view to the proxy whenever it changes (or once a second, to
    // tick the AFK 10m countdown). The proxy paints from the pushed
    // view ; its local rules are bootstrap fallback only.
    //
    // Architecture (david `fdzg4e`) : timer ↔ proxy IPC via a
    // dedicated UDS (`view-push.sock`), persistent connection,
    // newline-delimited JSON. The pusher reconnects transparently
    // if the socket drops (proxy reload, etc.).
    // #630 david `d59zge` : LoopStateBus owns the prev-view + emits
    // typed events on transitions. The push-to-proxy hook listens to
    // `transition` (any change) and forwards via the existing pusher.
    // Other consumers can subscribe to specific events (bootEnded,
    // afkArmed10m, …) for log decoration or future reactive painters
    // without re-implementing the diff.
    const viewPusher = createViewPusher(viewPushSockPath(sd!));
    // #633 Slice A (david `ecmrvn`) — back-channel server : the proxy
    // connects + emits raw events (typing, AFK key, lone-esc). The state
    // machine here decides what to do based on the AUTHORITATIVE view
    // (incl. bootComplete marker), eliminating the layer-2 hacks where
    // the proxy guessed locally and the timer filtered post-fact.
    const proxyEventsServer = createProxyEventsServer(proxyEventsSockPath(sd!), (event) => {
        // #633 Slice F (david `yau5jc`) — dispatcher logic lives in its
        // own module (`proxy-event-dispatcher.ts`), unit-testable with a
        // tmp state-dir. The timer here just bridges the UDS callback to
        // the dispatcher and logs the verdict.
        const verdict = dispatchProxyEvent(sd!, event);
        log(formatVerdictLogLine(verdict));
    });
    process.on("exit", () => proxyEventsServer.close());
    // #652 Slice 6 — wire the HookService → bar subscriber. Currently
    // only paints on UserPromptSubmit (→ BUSY) ; future slices can add
    // SessionStart / Stop paints once the events carry the substate
    // the existing hooks compute inline.
    const hookBarSub = installHookBarSubscriber(name!);
    process.on("exit", () => hookBarSub.close());
    // #649 Slice 4 — hydrate the in-process AfkService singleton from
    // the afk marker file + keep it in sync via fs.watch. The file
    // remains the cross-process source of truth (proxy F9, timer's own
    // armAfk10m paths) ; AfkService is the typed observable façade for
    // in-process subscribers (future bar countdown + wake gate). The
    // watcher does the initial hydrate itself.
    const unwatchAfk = watchAfkMarker(sd!);
    process.on("exit", () => unwatchAfk());
    const loopBus = new LoopStateBus();
    loopBus.on("transition", (_prev, next) => {
        viewPusher.push(next);
        // #629 (xyss9z) : trace which writer drove the @cl_human change.
        // The timer doesn't setOpt directly — the proxy does, after receiving
        // the pushed view — but the timer is the ORIGIN of the value.
        logBarPaint(sd, "timer.ts:bus.transition", next.barWord);
    });
    // #629 david `2hwuan` + `8wgq7f` — sceller la fin de boot : écrit
    // bootComplete marker directement (plus via setResumePicker, qui ne
    // touche plus bootComplete depuis #629). Une fois posé, isInBootGrace
    // early-return false ad vitam — donc Resuming conversation… puis /compact
    // mid-session ne peuvent pas ré-entrer en boot. L'event ne fire QUE
    // quand toutes les conditions ont vraiment dit not-in-boot (post-floor,
    // paneReady, no picker, no compacting) — c'est THE moment où on scelle.
    loopBus.on("bootEnded", () => {
        log("state-bus: boot phase ended — sealing bootComplete marker");
        try {
            writeFileSync(bootCompletePath(sd!), new Date().toISOString() + "\n");
        } catch { /* best-effort */ }
        // #639 david `pn97zf` — `--wait` (CL_WAIT=1) arms NOT AFK 10m at
        // boot exit so the bar reads `wait` yellow with a countdown : the
        // documented "managed mode" contract. `--no-wait` (CL_WAIT=0)
        // leaves AFK off — bar reads `loop` and auto-pings resume.
        const isWaitMode = cfg.wait;
        if (isWaitMode) {
            armAfkViaService(sd!);
            log("state-bus: boot phase ended — --wait → armed NOT AFK 10m (via service)");
        }
        // #629 david `jf6efv` — flip the bar BG out of [boot] IMMEDIATELY.
        // Without this, the BG stays yellow until the next heartbeat tick
        // (up to `interval` seconds = 30s default) — david observed boot
        // bar ending "at least 30s after the prompt returns". The bus
        // event fires the moment isInBootGrace transitions ; flip the
        // bar in the same tick.
        try {
            // Idle is the right default at boot exit ; busy-detect by the
            // next probe cycle if claude is mid-turn.
            setTmuxStatus(name!, LOOP_STATUS.IDLE);
        } catch { /* best-effort */ }
        // #629 david `7zqtgf` — drain stacked pings at boot exit. SSE pings
        // arriving during picker selection were silently skipped by user-grace
        // (picker keystrokes set user-took-over → 600s lock). At boot end the
        // user is implicitly done with the picker, so we clear user-took-over
        // FIRST then fire a wake. Subsequent typing (real session, post-boot)
        // re-arms user-grace as usual.
        try { unlinkSync(userTookOverPath(sd!)); } catch { /* race */ }
        void tryWake("boot-ended-drain");
    });
    // #629 david `7zqtgf` — same drain trigger when AFK is cleared (F9 from
    // NOT AFK 10m/∞ back to AFK). The bar word goes wait→loop ; any ping
    // that came while the hold was active should now fire. user-took-over
    // is the AFK-orthogonal gate, so we leave it intact here.
    loopBus.on("afkCleared", () => {
        void tryWake("afk-cleared-drain");
    });
    // #629 — fast probe 1s pendant boot. Arme au start (on est forcément
    // en boot à T0 via le floor), désarme sur bootEnded, ré-arme sur
    // bootStarted (n'arrive qu'en theory — bootComplete bloque la
    // ré-entrée, mais ceinture+bretelle).
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
                if (info && info !== lastPaintedBootInfo) {
                    setTmuxStatus(name!, LOOP_STATUS.BOOT, info);
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
        log("fast-probe: disarmed (boot ended)");
    };
    armFastProbe();
    loopBus.on("bootEnded", disarmFastProbe);
    loopBus.on("bootStarted", armFastProbe);
    loopBus.on("afkArmed10m", (expiry) => log(`state-bus: AFK 10m armed (expires ${new Date(expiry).toISOString()})`));
    loopBus.on("afkArmedInf", () => log("state-bus: AFK ∞ armed"));
    loopBus.on("afkCleared", () => log("state-bus: AFK cleared"));
    loopBus.on("pickerOpened", () => log("state-bus: resume picker opened"));
    loopBus.on("pickerClosed", () => log("state-bus: resume picker closed"));
    // #714 david `fu9mh7` — bus event `busy(next, prev)` reste publié
    // pour les consumers (logs ici + futurs render/decoration). La cadence
    // de refresh, elle, est PIGGYBACKÉE sur `pushViewIfChanged` qui tourne
    // déjà à 1s post-boot (cf. setInterval line ~1097). Un refresh
    // busy-gated chez nous était trop fragile : pour qu'il s'arme, il
    // fallait que le bus émette `busy(true)`, mais pour que le bus émette
    // `busy(true)`, il fallait que pane-busy soit fresh — chicken-and-egg.
    // david repro : `/compact` typed → `[busy:compacting]` n'apparaissait
    // qu'au prochain heartbeat (30s). Now refresh runs every 1s in BOTH
    // states ; cost ~5ms/s (1 tmux capture + 4-5 file syscalls). The bus
    // event still fires correctly on the transition and logs it.
    loopBus.on("busy", (next, prev) => {
        log(`state-bus: busy ${prev}→${next}`);
    });
    const pushViewIfChanged = (): void => {
        try {
            loopBus.update(readLoopStateInput(sd!));
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
    // Watch the state-dir for ANY marker change → schedule a push.
    try {
        watch(sd!, { persistent: false }, (_evt, name) => {
            if (!name) return;
            // Only react to the markers the LoopState service actually reads.
            if (name === "afk" || name === "user-took-over" || name === "human-typing"
                || name === "idle-since" || name === "wake-in-flight"
                || name === "busy-defer-until" || name === "loop-start-ts"
                // #647 Slice 2 follow-up — watch the new split picker files
                // (the legacy single `resume-picker-active` no longer exists).
                || name === "resume-session-picker-active"
                || name === "resume-mode-picker-active"
                || name === "boot-complete") {
                schedulePush();
            }
        });
    } catch (e) {
        log(`view-push: fs.watch on state-dir failed (${(e as Error).message ?? e}) — relying on periodic tick only`);
    }
    // Periodic tick : countdown ticks down second-by-second even with no
    // marker change ; push once a second so the AFK chunk reflects it.
    // Also acts as a safety net if fs.watch missed an event.
    setInterval(pushViewIfChanged, 1000);
    // #714 david — DEDICATED pane-marker refresh tick at 1s, decoupled from
    // `pushViewIfChanged` (which fires up to ~20×/s via the typing fs.watch
    // → schedulePush → each call used to spawn a tmux capture-pane). Capping
    // refresh to a flat 1s keeps cost bounded (~5ms/s constant, regardless
    // of typing rate). The bus view that `pushViewIfChanged` computes still
    // reads the latest pane-* markers — just up to 1s stale on the tail,
    // which is the same cadence as the `busy` event we publish anyway.
    setInterval(() => {
        try { refreshPaneMarkers(); } catch { /* best-effort */ }
    }, 1000);
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
        // Manual wake (claude-loop wake NAME): file marker, fires
        // even when SSE silent.
        if (existsSync(wakeRequestedPath(sd!))) {
            await tryWake("manual", true);
            continue;
        }
        // SSE-drop safety net: re-check the gate ourselves.
        if (!wakeBus.isConnected()) wakeBus.connect();
        const woke = await tryWake("heartbeat");
        if (!woke && existsSync(idleMarkerPath(sd!))) {
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
        // Refresh the bar with the current unread count (#B.149
        // david: "dans la barre mux on peut afficher le nombre de
        // read / ticket meme en idle ?"). Skipped while booting —
        // count is meaningless until settleBoot or the probe
        // detected claude is ready (whichever comes first).
        if (phase !== "boot") {
            try {
                const r = await client().pingsCount() as { unread?: number };
                // #B.198: during user-grace, the third arg is the
                // grace label ("user") instead of the unread count —
                // matches the Stop hook's `[idle:user]` rendering so
                // the bar stays consistent across the whole window.
                // Count comes back once grace lapses.
                // #629 david `8wgq7f` (Bug 3) — flush the bus before flipping
                // status-bg. The bus's transition listener pushes the new
                // view to the proxy synchronously (UDS write), so the proxy
                // can repaint @cl_human BEFORE the tmux status-bg flips here.
                // Without this, status-bg gray lands first and the word
                // `boot` lingers ~50ms (watch debounce) before the proxy
                // catches up — visible race at boot exit.
                pushViewIfChanged();
                // #647 Slice 4 : pane-derived markers (screen-takeover or
                // error) trump count/user as bar info — david `sr9kqw`
                // wants `[busy:compacting]` / `[boot:picker:mode]` etc.
                // visible. `paneMarkerBarInfo()` returns null when no
                // marker is salient, falling back to the existing logic.
                const paneInfo = paneMarkerBarInfo();
                if (paneInfo) {
                    setTmuxStatus(name!, phase, paneInfo);
                } else if (phase === "idle" && userIsTakingOver(sd!, userGraceSec)) {
                    setTmuxStatus(name!, phase, "user");
                } else {
                    setTmuxStatus(name!, phase, r.unread ?? 0);
                }
            } catch { /* swallow — bar stays as-is */ }
        }
        // #B.177 B1: heartbeat push of current state to the daemon
        // so the consumers panel shows `[busy]`/`[idle]`/`[boot]` per
        // agent + an "offline" badge after the heartbeat goes stale.
        // Fire on EVERY tick (not just transitions) — the daemon
        // updates `state_updated_at` always, freshness signal for
        // the UI's offline detector.
        // #280: also push live human-presence so the panel can render
        // `human` vs autonomous `loop` while the heartbeat is fresh —
        // same signal the tmux bar uses for its loop/stop word (a human
        // typing now, or within user-grace after a manual prompt).
        try {
            const human = humanPresent(sd!, userGraceSec);
            // #310: also push the 3-state presence word (stop/wait/loop) so the
            // consumers page mirrors the tmux bar, not just the binary human flag.
            const humanWord = humanPresenceWord(sd, userGraceSec);
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
        const manualWake = existsSync(wakeRequestedPath(sd!));
        const woke = await tryWake(manualWake ? "manual" : "check-cmd hit", manualWake);
        // #251: same idle-gated self-reload as mainSse — pick up moved
        // source only in the lull (no wake fired AND claude is idle).
        if (!woke && existsSync(idleMarkerPath(sd!))) selfReloadIfStale();
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
