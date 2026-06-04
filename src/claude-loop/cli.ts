#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop CLI (#B.63 TS port). Generic terminal wrapper that
 * makes a Claude Code session tickable via tmux + a Stop hook + a
 * detached timer process that wakes claude when idle by sending a
 * random ping phrase every CL_INTERVAL seconds. Claude decides what
 * (if anything) to do based on its own context / MCP tools.
 *
 * Subcommands (start is default): `start | list | attach | tail | rm
 * | wake | reload | check | status | trace | prune`. Anything after `--`
 * is passed verbatim to the spawned `claude`.
 */
import { spawn, spawnSync } from "node:child_process";
import { commandExists } from "../sysdeps.js";
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { AiballClient } from "../client.js";
import { AIBALL_VERSION } from "../version.js";
import { bootstrapInit, installSkill } from "../cli/bootstrap.js";
import { applyBootstrapOptions } from "../cli/bootstrap-options.js";
import { applyToProcessEnv, resolveProjectContext, warnIfDeprecated } from "./project-context.js";
import { readLocalRemote, writeLocalRemote } from "./local-config.js";
import { parseAfkKey, bytesToGrammar, matchAfkCombo, type AfkSpec } from "./afk-key.js";
import { acquireStartLock } from "./start-lock.js";
import {
    canonicalCwd,
    DEFAULT_CHECK_CMD,
    isInternalCheckCmd,
    LOOP_STATUS,
    MUX_CMD,
    STATE_ROOT,
    defaultPingsPath,
    envPath,
    humanTypingPath,
    idleMarkerPath,
    installRootSha,
    isLoopStale,
    logBarPaint,
    loopStartTsPath,
    pickPingPhrase,
    pingsPath,
    platePath,
    projectCwdInfo,
    readPlate,
    setTmuxStatus,
    stateDirFor,
    timerLogPath,
    timerPidPath,
    tmuxName,
    writePlate,
    ensureDir,
    zenPath,
    type Plate,
} from "./state.js";
import { cmdTail, type TailMode } from "./cmds/tail.js";
import { cmdPrune, cmdReload, cmdRestart, cmdRm, cmdStop, cmdWake, cmdZen } from "./cmds/manage.js";
import { cmdInspect } from "./cmds/inspect.js";
import { CL_ENV } from "./env-vars.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop: ${msg}\n`);
    process.exit(1);
}

function need(cmd: string): void {
    // `command -v` is a bash builtin — fails under cmd.exe. Use the
    // OS PATH lookup tool instead (`where` on Windows, `which`
    // elsewhere) so the probe works on every supported shell.
    const probe = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(probe, [cmd], { stdio: "ignore" });
    if (r.status !== 0) die(`missing dependency: ${cmd}`);
}

function has(cmd: string): boolean {
    return commandExists(cmd);
}

/**
 * Convert a Windows path to its 8.3 short form (no spaces). psmux
 * splits the command at spaces when it rebuilds the CreateProcess
 * command line, so an absolute path like "C:\Program Files\Git\bin\
 * bash.exe" gets truncated to "C:\Program". The 8.3 name
 * ("C:\PROGRA~1\Git\bin\bash.exe") sidesteps that. No-op on non-Windows
 * or for paths that already lack spaces. Falls back to the input if
 * the conversion fails (8.3 generation disabled on the volume, etc.).
 */
function toShortPathWin(p: string): string {
    if (process.platform !== "win32" || !p.includes(" ")) return p;
    try {
        const out = spawnSync("cmd.exe", ["/c", `for %I in ("${p}") do @echo %~sI`], { encoding: "utf8" });
        const short = (out.stdout ?? "").trim();
        if (short && existsSync(short)) return short;
    } catch { /* fall through to raw path */ }
    return p;
}

// Pick the local clipboard tool tmux should pipe selections into. OSC 52
// (`set-clipboard on`) works in some terminals (Alacritty, Windows
// Terminal, kitty, recent gnome-terminal) but is rejected by default
// in VTE-based terminals like Ptyxis (#B.181 follow-up). When a real
// clipboard binary is on the host we prefer it; OSC 52 stays on as the
// remote-session (SSH) fallback.
function resolveClipboardCmd(): string | null {
    if (process.platform === "darwin" && has("pbcopy")) return "pbcopy";
    if (process.env.WAYLAND_DISPLAY && has("wl-copy")) return "wl-copy";
    if (process.env.DISPLAY && has("xclip")) return "xclip -selection clipboard -i";
    if (process.env.DISPLAY && has("xsel")) return "xsel --clipboard --input";
    return null;
}

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// #689 david `4hp9j6` — identity vars derived from the start invocation
// (loop name, state dir, tmux session, pings path). Excluded from shell-env
// override since accepting a stale `CL_NAME=...` from the caller's shell
// would silently point the loop at the wrong state dir.
const IDENTITY_ENV_KEYS = new Set<string>([
    CL_ENV.NAME,
    CL_ENV.STATE_DIR,
    CL_ENV.TMUX,
    CL_ENV.PINGS,
]);

/**
 * #689 — at `claude-loop start`, for every CL_X in the registry that's
 * defined in the invoker's shell env, override the corresponding
 * `export CL_X=...` line in the freshly-built envLines (or append it if
 * absent). Identity keys are exempt — they belong to the start logic.
 * Logs `shell-overridden : K=V, K=V` to stdout so the effect is visible
 * (no silent override — the failure mode we called out when killing D2
 * on #684).
 */
function applyShellOverrides(envLines: string[]): string[] {
    const out = [...envLines];
    const overridden: string[] = [];
    for (const key of Object.values(CL_ENV)) {
        if (IDENTITY_ENV_KEYS.has(key)) continue;
        const shellVal = process.env[key];
        if (shellVal === undefined) continue;
        const newLine = `export ${key}=${shQuote(shellVal)}`;
        const exportLine = new RegExp(`^export ${key}=`);
        const idx = out.findIndex((l) => exportLine.test(l));
        if (idx >= 0) {
            out[idx] = newLine;
        } else {
            // Append before the trailing empty line if any (cosmetic).
            if (out[out.length - 1] === "") out.splice(out.length - 1, 0, newLine);
            else out.push(newLine);
        }
        overridden.push(`${key}=${shellVal}`);
    }
    if (overridden.length > 0) {
        process.stdout.write(`shell-overridden : ${overridden.join(", ")}\n`);
    }
    return out;
}

function tmuxAlive(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    return r.status === 0;
}

function selfRoot(): string {
    // src/claude-loop/cli.ts → up 2 = repo root
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
}

/**
 * #594 — single-shot loop name format : `cl-<project>-<hash6>` where
 * `hash6 = sha256(canonicalCwd + ':' + agent).slice(0, 6)`.
 *
 * Stable (same cwd + agent → same hash → same loop retrieved), distinct
 * by default (no fallback chain), aligned with `tmuxName` (identity) +
 * `stateDirFor` (uses the name as-is) so the 3 derived strings match.
 *
 * Older loops (pre-#594) carry the legacy `cl-<project>` shape ; voie A
 * migration (david `nndjjb`) — no rename, the legacy loops survive until
 * `claude-loop rm` and the next start uses the new format.
 */
function shortHash(cwd: string, agent: string | undefined): string {
    const input = `${cwd}:${agent ?? ""}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 6);
}

function defaultName(project: string | undefined, agent: string | undefined, cwd: string): string {
    const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const p = project ? slug(project) : "loop";
    return `cl-${p}-${shortHash(canonicalCwd(cwd), agent)}`;
}

interface StartOpts {
    name?: string;
    /**
     * Tick interval seconds. null = use the resolved
     * `.aiball.yaml claude_loop.interval_seconds` default (#B.180).
     * Set by the CLI only when --interval was explicitly passed.
     */
    interval: number | null;
    checkCmd: string;
    pings?: string;
    attach?: boolean;
    noStartupPing?: boolean;
    /** #636 david — pytest harness mode : the timer process exits after
     *  one full heartbeat cycle (boot probe + tick + wake check). claude
     *  + tmux stay alive ; the caller orchestrates cleanup. */
    runOnce?: boolean;
    /** #302: false = `--no-wait` (no human at the terminal → eager boot
     *  drain, no boot-grace deferral). Default/undefined = `--wait`. */
    wait?: boolean;
    /** Bypass the live-loop conflict check (#B.154). */
    force?: boolean;
    /** Resume-picker auto-dismiss (#B.154): summary | as-is | abort. */
    resumeMode?: string;
    /**
     * #390: target a REMOTE aiball daemon over HTTP (http[s]://host:port)
     * instead of the local Unix socket. Set → remote mode. The loop stays
     * local; only the aiball data-plane is remote.
     */
    aiballUrl?: string;
    /** #390: bearer token for the remote daemon (`aiball auth issue` on the host). */
    aiballToken?: string;
    /** #390: consumer id = loop identity (overrides resolved ctx.agent). */
    consumer?: string;
    /** #390: project name (overrides resolved ctx.project). */
    project?: string;
    /** #393: launch the loop in this directory instead of the invoker's cwd
     *  (e.g. the daemon starting a loop for a known project root from the UI). */
    cwd?: string;
    /**
     * #557 : run `claude-loop init` first (bootstrap .mcp.json/.aiball.yaml
     * + persist remote if `--aiball-url` is given), then start the loop —
     * one-liner pour le user qui veut bootstraper-puis-lancer en une commande.
     */
    init?: boolean;
    /** #557 : forwarded to bootstrap when `--init` is set. */
    initForce?: boolean;
    /** #557 : forwarded to bootstrap (--stop-hook) when `--init` is set. */
    initStopHook?: boolean;
    /** #557 : forwarded to bootstrap (--global) when `--init` is set. */
    initGlobal?: boolean;
    /** #593 : forwarded to bootstrap (--private) when `--init` is set. */
    initPrivate?: boolean;
    /** #616 : --no-resume → opt out from `claude.always_resume: true` for
     *  this invocation only. Injected as `--no-resume` into claudeArgs so
     *  the existing detection at the always_resume site sees the sentinel
     *  and skips the auto-inject. */
    noResume?: boolean;
    /** #639 (david `uqdava`) : --resume → force both `claude.always_resume`
     *  AND `claude_loop.auto_resume` to true for this invocation, regardless
     *  of `.aiball.yaml`. Mirror of `noResume` for the positive case. */
    forceResume?: boolean;
    /** #749 david — start with the wake kill-switch ON. cmdStart touches the
     *  `zen` marker right after the state-dir is created so the first
     *  tryWake (boot drain) is already muted. */
    zen?: boolean;
    claudeArgs: string[];
}

/**
 * Silently prune state dirs whose tmux session no longer exists.
 * Called before `start` so orphans don't accumulate; safe no-op
 * when the state root is empty.
 */
function pruneDeadStateDirs(): void {
    if (!existsSync(STATE_ROOT)) return;
    for (const name of readdirSync(STATE_ROOT)) {
        // #403: skip dotfiles — `.start-lock-*` lives here; a concurrent start's
        // prune must NOT delete a live lock (that would re-open the race).
        if (name.startsWith(".")) continue;
        if (tmuxAlive(name)) continue;
        try { rmSync(stateDirFor(name), { recursive: true, force: true }); }
        catch { /* ignore */ }
    }
}

/**
 * #616 (david arf8xs) — does claude have any prior conversation
 * recorded for this cwd ? claude stores sessions under
 * `~/.claude/projects/<encoded-cwd>/*.jsonl`. The encoding replaces
 * every NON-alphanumeric character (slash, underscore, dot, …) by
 * `-`, then prepends a leading `-`. Confirmed by david's `azuc5s`
 * repro on `/home/david/work/test_no_resume_auto` →
 * `~/.claude/projects/-home-david-work-test-no-resume-auto/` (the
 * underscores collapsed to dashes alongside the slashes).
 *
 * Used by the always_resume injection : if the dir is missing or
 * empty, `claude --resume` would block on an empty picker — skip the
 * auto-inject and let the user start fresh. Best-effort : returns
 * `true` on any IO error so a permissions glitch falls back to the
 * pre-#616 behaviour (inject --resume, claude figures it out).
 */
function hasClaudeSessions(cwd: string): boolean {
    try {
        const abs = resolve(cwd);
        // #620 (aiball-win) : Windows fix. The old encoder stripped a
        // leading `/` then prepended `-` — Unix-shaped only. On Windows
        // the absolute path starts with a drive letter (`C:\\Users\\…`),
        // so there's no leading `/` to strip + the prepend yielded
        // `-C--Users-…` while claude's real dir is `C--Users-…`. Drop
        // the special-case : just collapse every non-alnum char to `-`
        // (matches claude's own encoder). On Unix the leading `/` maps
        // to `-` by the same rule, so output stays identical.
        const encoded = abs.replace(/[^a-zA-Z0-9]/g, "-");
        const dir = join(homedir(), ".claude", "projects", encoded);
        if (!existsSync(dir)) return false;
        return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
    } catch {
        return true;
    }
}

/**
 * Find a LIVE loop (tmux session present) running in the same cwd
 * AND for the same agent. Used by `start` to refuse a duplicate
 * spawn — david: "pluieurs claude-loop nommé pareil devrait pas
 * etre permis (meme agent)". Agent matched via the loop's env file
 * CL_NAME / AIBALL_AGENT export if present.
 */
function findLiveLoopForCwdAgent(cwd: string, agent: string | undefined): { name: string; agent: string | null } | null {
    if (!existsSync(STATE_ROOT)) return null;
    // #414: compare canonical paths so a symlinked alias of the same dir matches
    // (the live plate may have been written with the other alias).
    const wantCwd = canonicalCwd(cwd);
    for (const name of readdirSync(STATE_ROOT)) {
        if (name.startsWith(".")) continue; // #403 lock dotfiles aren't loops
        if (!tmuxAlive(name)) continue;
        let plate: Plate | null = null;
        try { plate = readPlate(stateDirFor(name)); } catch { /* skip */ }
        if (!plate) continue;
        if (canonicalCwd(plate.cwd) !== wantCwd) continue;
        const envFile = envPath(stateDirFor(name));
        let loopAgent: string | null = null;
        if (existsSync(envFile)) {
            const m = readFileSync(envFile, "utf8").match(/export AIBALL_AGENT=['"]?([^'"\n]+)/);
            if (m) loopAgent = m[1];
        }
        if (agent && loopAgent && agent !== loopAgent) continue;
        return { name, agent: loopAgent };
    }
    return null;
}

/**
 * Resolve the "current" loop for tail / wake when no name is passed:
 * the loop registered to the invoker's cwd. Prefer alive loops on
 * ties — `claude-loop tail` is "show me what's happening now", so a
 * live session beats a stale state dir from a prior run.
 */
/**
 * Best-effort: the registered loops whose plate cwd matches the current
 * cwd (symlink-safe, #414), each with its tmux liveness. Never dies —
 * returns [] when the state root is missing or nothing matches. Shared
 * by `resolveCurrentLoopName` (which layers the die-on-ambiguity policy)
 * and read-only callers like `status` that just want the picture.
 */
function loopsForCwd(): { name: string; alive: boolean }[] {
    if (!existsSync(STATE_ROOT)) return [];
    const cwd = canonicalCwd(process.env.AIBALL_CWD ?? process.cwd());
    const matches: { name: string; alive: boolean }[] = [];
    for (const name of readdirSync(STATE_ROOT)) {
        const sd = stateDirFor(name);
        if (!existsSync(platePath(sd))) continue;
        let plate: Plate | null = null;
        try { plate = readPlate(sd); } catch { continue; }
        if (canonicalCwd(plate.cwd) !== cwd) continue;
        matches.push({ name, alive: tmuxAlive(name) });
    }
    return matches;
}

function resolveCurrentLoopName(): string {
    const cwd = canonicalCwd(process.env.AIBALL_CWD ?? process.cwd()); // #414 symlink-safe
    if (!existsSync(STATE_ROOT)) die(`no loops registered (state root ${STATE_ROOT} missing). Pass a name or start one first.`);
    const matches = loopsForCwd();
    if (matches.length === 0) die(`no claude-loop registered for cwd ${cwd}. Pass a name or run \`claude-loop list\`.`);
    if (matches.length === 1) return matches[0].name;
    const alive = matches.filter((m) => m.alive);
    if (alive.length === 1) return alive[0].name;
    const names = matches.map((m) => `${m.name}${m.alive ? "" : " (dead)"}`).join(", ");
    die(`multiple loops in cwd ${cwd}: ${names}. Pass a name explicitly.`);
}

async function cmdStart(opts: StartOpts): Promise<void> {
    need(MUX_CMD);

    // #B.154: ProjectContext resolves cwd + AIBALL_AGENT +
    // AIBALL_PROJECT from .mcp.json once, then writes them back to
    // process.env so the timer + hooks + claude spawn with the
    // right identity. Single source for every subcommand.
    // #393: --cwd launches the loop in an explicit directory (e.g. the daemon
    // spawning a loop for a known project root from the UI) instead of the
    // invoker's cwd. Threads through ctx.cwd → plate.cwd, tmux `-c`, config
    // resolution, and the conflict checks below.
    const startCwd = opts.cwd ? resolve(opts.cwd) : undefined;
    if (startCwd && !existsSync(startCwd)) {
        die(`--cwd path does not exist: ${startCwd}`);
    }
    // #557 : `--init` = `claude-loop init` + start, en un coup. Bootstrap se
    // déroule AVANT toute autre logique de start (ProjectContext.resolve,
    // start-lock, plate, etc.) pour que les fichiers `.mcp.json`/`.aiball.yaml`
    // soient en place quand le start lit ensuite la config. Init est
    // idempotent (skip silencieux si fichiers déjà présents — sauf --force).
    // Note : init doit tourner DANS le cwd cible (--cwd) si fourni, sinon
    // bootstrap écrirait dans le mauvais dossier. Bootstrap utilise
    // `process.cwd()`, donc on bascule temporairement.
    if (opts.init) {
        const origCwd = process.cwd();
        if (startCwd) process.chdir(startCwd);
        try {
            cmdInitRemote({
                aiballUrl: opts.aiballUrl,
                aiballToken: opts.aiballToken,
                consumer: opts.consumer,
                project: opts.project,
            });
            await bootstrapInit({
                force: opts.initForce === true,
                stopHook: opts.initStopHook === true,
                global: opts.initGlobal === true,
                private: opts.initPrivate === true,
                // #603 (4dzxp2) : forward identity to bootstrap so `start --init`
                // matches `init` behavior (consumer + project also seeded
                // dans .aiball.yaml, pas juste .aiball.local.yaml).
                consumer: opts.consumer,
                project: opts.project,
                // #612 — same tri-state for --no-claim on the start --init path.
                noClaim: process.argv.includes("--no-claim") ? true : undefined,
            });
        } finally {
            if (startCwd) process.chdir(origCwd);
        }
    }
    // #394 volet A: a persisted remote config (`claude-loop init`) makes a plain
    // `claude-loop start` reconnect to the same REMOTE aiball without re-passing
    // flags. Explicit flags still win (only fill what wasn't passed).
    const localRemote = readLocalRemote(startCwd ?? process.cwd());
    if (localRemote) {
        opts.aiballUrl ??= localRemote.url;
        opts.aiballToken ??= localRemote.token;
        opts.consumer ??= localRemote.consumer;
        opts.project ??= localRemote.project;
    }
    const ctx = resolveProjectContext(startCwd ? { cwd: startCwd } : {});
    // #390: explicit flags override the resolved identity (the loop's
    // consumer/project are passed at launch, independent of any local
    // .aiball.yaml — David's "consumer_id pas propre au remote").
    if (opts.consumer) ctx.agent = opts.consumer;
    if (opts.project) ctx.project = opts.project;
    // #420: resolve the loop name AFTER the agent is known, so an omitted --name
    // defaults to a per-agent slug → two loops in the same dir under different
    // agents auto-get distinct names. Explicit --name still wins.
    // #594 — pass cwd so the hash is stable per (cwd, agent).
    const name = opts.name ?? defaultName(ctx.project, ctx.agent, startCwd ?? process.cwd());
    const sd = stateDirFor(name);
    if (existsSync(sd)) {
        // #602 — with the deterministic naming (#594), restarting from the
        // same (cwd, agent) always hits the SAME state-dir. If the previous
        // loop crashed / was killed leaving its state-dir behind, the old
        // "die unless --name override" path forced the user to manually
        // `rm` it before restarting (regression vs the pre-#594 random
        // suffix fallback). Auto-clean a dead state-dir so a plain
        // `claude-loop start` from a project that recently had a loop
        // just works.
        if (tmuxAlive(name)) {
            die(`loop '${name}' already alive at ${sd}. Attach via 'claude-loop attach' or 'rm ${name}' first to start fresh.`);
        }
        rmSync(sd, { recursive: true, force: true });
        process.stdout.write(`claude-loop: removed stale state-dir for dead loop '${name}' (cleared so restart can reuse the same deterministic name)\n`);
    }
    applyToProcessEnv(ctx);
    warnIfDeprecated(ctx);
    // #390: remote-daemon mode. --aiball-url points the loop's aiball
    // client at a REMOTE daemon over HTTP+token instead of the local
    // socket. Exported into process.env BEFORE the auto-register call
    // below so it (and the spawned claude session + its MCP server, which
    // inherit this env) all reach machine A. The timer + hooks read the
    // same values from the persisted env file (built further down).
    if (opts.aiballUrl) {
        if (!opts.aiballToken) {
            die("--aiball-url requires --aiball-token (mint one on the daemon host with `aiball auth issue --consumer <id>`)");
        }
        process.env.AIBALL_URL = opts.aiballUrl;
        process.env.AIBALL_TOKEN = opts.aiballToken;
        // Critical: AIBALL_SOCK defaults to $AIBALL_HOME/sock; an empty
        // value forces the TCP transport, else the client silently routes
        // back to a local socket that isn't there on machine B.
        process.env.AIBALL_SOCK = "";
    }
    // #414: canonicalise once so the start-lock key, plate.cwd, tmux -c and the
    // dup-loop conflict check share ONE symlink-collapsed identity — else a
    // start from a symlinked alias of the same dir slips past the guard.
    const cwd = canonicalCwd(ctx.cwd);

    // #B.216 david (979632): auto-register the project with the aiball
    // daemon so `claude-loop start` in any dir surfaces a fresh entry
    // in ProjectsPanel without a separate `aiball project init`. Best
    // effort — daemon down or 409 (already registered) both swallow
    // silently to a one-line status. Never blocks the loop spawn.
    if (ctx.project) {
        try {
            await new AiballClient().createProject(ctx.project);
            process.stdout.write(`aiball: registered project '${ctx.project}'\n`);
        } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (/409|already exists/i.test(m)) {
                process.stdout.write(`aiball: project '${ctx.project}' already registered\n`);
            } else {
                process.stdout.write(`aiball: project register skipped — ${m}\n`);
            }
        }
    }

    // #B.154: housekeeping before spawn. (1) prune dead state dirs
    // so the user's ~/.claude-loop/ doesn't accumulate orphans from
    // every test run; (2) refuse to spawn if another LIVE loop
    // already runs in the same cwd for the same agent — david saw
    // 14 dead loops accumulate from repeated rm-less restarts.
    pruneDeadStateDirs();
    if (!opts.force) {
        // #403: take an ATOMIC start lock on (cwd, agent) BEFORE the live-loop
        // check, to close the check-then-spawn TOCTOU race — two concurrent
        // `claude-loop start` in the same dir+agent can no longer both win
        // (O_EXCL: one creates the lock, the other sees a live holder). Held
        // until this start process exits (by then the tmux session exists and
        // findLiveLoopForCwdAgent guards the steady state). A stale lock from a
        // crashed start self-reclaims (dead holder pid). `--force` bypasses.
        const releaseLock = acquireStartLock(STATE_ROOT, cwd, ctx.agent);
        if (releaseLock === null) {
            die(
                `another 'claude-loop start' is in progress (or a loop is live) for ${cwd}` +
                (ctx.agent ? ` for agent '${ctx.agent}'` : "") +
                `.\n  Retry in a moment, attach the live loop, or override with --force.`,
            );
        }
        process.once("exit", releaseLock);
        const conflict = findLiveLoopForCwdAgent(cwd, ctx.agent);
        if (conflict) {
            die(
                `live loop '${conflict.name}' already runs in ${cwd}` +
                (conflict.agent ? ` for agent '${conflict.agent}'` : "") +
                `.\n  Attach with: claude-loop attach ${conflict.name}\n  Override with: --force\n  Stop with: claude-loop rm ${conflict.name}`,
            );
        }
    }
    const pingsSrc = opts.pings ?? defaultPingsPath();
    if (!existsSync(pingsSrc)) die(`pings file not found: ${pingsSrc}`);

    ensureDir(sd);
    // #622 — write the loop session start once at launch so short-lived
    // hooks (session-start, user-prompt-submit, stop) all derive boot-grace
    // from the SAME instant. Without it each hook read its own module-load
    // time as the start, so the boot window appeared eternally fresh and
    // the bar word fallback (degraded mode) stayed `boot` forever.
    writeFileSync(loopStartTsPath(sd), String(Date.now()));
    copyFileSync(pingsSrc, pingsPath(sd));
    // #749 david — `--zen` start opt-in : touch the kill-switch marker so
    // the very first tryWake (boot drain) is already muted. The user opts
    // back in via `claude-loop zen <name>` (toggle / --off).
    if (opts.zen === true) {
        writeFileSync(zenPath(sd), new Date().toISOString() + "\n");
    }

    // #B.180 david: resolve timeouts (CLI flag > .aiball.yaml > built-in
    // default). loadConfig defaults are 60/60/300/2000 — see config.ts.
    const interval = opts.interval ?? ctx.claude_loop.interval_seconds;
    const bootGraceSec = ctx.claude_loop.boot_grace_seconds; // PTY-proxy bridge
    const escTakeover = ctx.claude_loop.esc_takeover; // PTY-proxy bridge
    // #305 (option a): explicit --wait/--no-wait wins; else the per-project
    // `.aiball.yaml claude_loop.wait` default (global CLI default stays no-wait #343).
    const wait = opts.wait !== undefined ? opts.wait : ctx.claude_loop.wait;
    // #351: parse afk_key → byte combos for the PTY proxy. A bad spec logs +
    // disables AFK (empty spec) rather than failing the whole launch.
    let afkSpecJson = "";
    try {
        afkSpecJson = JSON.stringify(
            parseAfkKey(ctx.claude_loop.afk_key, ctx.claude_loop.afk_window_ms).combos,
        );
    } catch (e) {
        process.stderr.write(
            `claude-loop: invalid afk_key "${ctx.claude_loop.afk_key}" — AFK disabled (${(e as Error).message})\n`,
        );
    }

    const plate: Plate = {
        name,
        created_at: new Date().toISOString(),
        interval,
        check_cmd: opts.checkCmd,
        pings_path: pingsPath(sd),
        cwd,
        claude_args: opts.claudeArgs,
        // #B.225: stamp the install-root SHA so `list` / `check` can
        // flag the daemon when source moves past what its timer loaded.
        started_at_sha: installRootSha(),
        // #390: persist the remote connection so `restart` replays it.
        remote: opts.aiballUrl
            ? {
                  url: opts.aiballUrl,
                  token: opts.aiballToken,
                  consumer: opts.consumer ?? ctx.agent,
                  project: opts.project ?? ctx.project,
              }
            : null,
    };
    writePlate(sd, plate);

    // Env file sourced before spawning claude (the Stop hook + timer
    // both read CL_* vars).
    const envLines = [
        `# AUTO-GENERATED by \`claude-loop start ${name}\` at ${new Date().toISOString()}`,
        `# Do not edit by hand. To change a value mid-life :`,
        `#   claude-loop reload <name> --set CL_FOO=bar`,
        "",
        // Identity (start-invocation only, never override) :
        `export ${CL_ENV.NAME}=${shQuote(name)}`,
        `export ${CL_ENV.STATE_DIR}=${shQuote(sd)}`,
        `export ${CL_ENV.PINGS}=${shQuote(pingsPath(sd))}`,
        // CLI-only flags (no yaml backing, no shell override) :
        // Read by the SessionStart hook to decide whether to ping at
        // boot. Empty / unset = ping (per default). "1" = stay silent.
        `export ${CL_ENV.NO_STARTUP_PING}=${shQuote(opts.noStartupPing ? "1" : "")}`,
        // #636 david — pytest harness flag, exits the timer after 1 cycle.
        `export ${CL_ENV.RUN_ONCE}=${shQuote(opts.runOnce ? "1" : "")}`,
        // #B.154: resume picker auto-dismiss mode. Read by the
        // SessionStart hook when source=resume.
        `export ${CL_ENV.RESUME_MODE}=${shQuote(opts.resumeMode ?? "as-is")}`,
        `export ${CL_ENV.CHECK_CMD}=${shQuote(opts.checkCmd)}`,
        // PTY-proxy bridge : pty-proxy.py is Python, can't call `loopConfig()` ;
        // these stay in the env file as a python-side mirror of the yaml. The
        // TS callers all read via `loopConfig().claude_loop.X` directly.
        // #302/#343: WAIT — Python proxy reads CL_WAIT for boot-grace gate.
        `export ${CL_ENV.WAIT}=${shQuote(wait ? "1" : "0")}`,
        // #B.180 boot-grace : the proxy needs it to count remaining grace.
        `export ${CL_ENV.BOOT_GRACE_SEC}=${shQuote(String(bootGraceSec))}`,
        // #345: bare ESC in the pane forwarded to claude as an interrupt
        // (PTY-proxy: CL_ESC_TAKEOVER). #745 phase B — the user-grace
        // re-arm that used to gate on this is gone, AFK SM owns it.
        `export ${CL_ENV.ESC_TAKEOVER}=${shQuote(escTakeover ? "1" : "0")}`,
        // #351: AFK key combo + post-fire debounce window drive the PTY
        // proxy's AFK detection → `afk` marker.
        `export ${CL_ENV.AFK_SPEC}=${shQuote(afkSpecJson)}`,
        `export ${CL_ENV.AFK_WINDOW_MS}=${shQuote(String(ctx.claude_loop.afk_window_ms))}`,
        // #619 jjfdea : passed to the proxy so it can render the full
        // `<prefix> AFK:<key>` label with on/off colour toggling.
        `export ${CL_ENV.AFK_KEY_DISP}=${shQuote(ctx.claude_loop.afk_key.trim().toUpperCase())}`,
        `export ${CL_ENV.AFK_LABEL_FG_DIM}=${shQuote(ctx.colors.afk_label_fg)}`,
        `export ${CL_ENV.AFK_LABEL_FG_LIT}=${shQuote(ctx.colors.bar_fg)}`,
        // #381c CL_PROXY_LOG, #629 CL_BAR_PAINT_LOG, #678 CL_PANE_CAPTURE_LOG :
        // opt-in debug logs are picked up generically by `applyShellOverrides`
        // below when set in the invoker's shell — no per-var conditional needed.
        // #B.154: persist the resolved aiball identity (from ctx) so
        // every hook fire and the timer process see the SAME
        // consumer as the spawn-time .mcp.json resolution. Without
        // this, a hook spawned via a fresh shell could fall back to
        // a random uuid via AiballClient.
        ...(ctx.agent ? [`export AIBALL_AGENT=${shQuote(ctx.agent)}`] : []),
        ...(ctx.project ? [`export AIBALL_PROJECT=${shQuote(ctx.project)}`] : []),
        // #508 phase A2 — propagate the project-yaml no_claim flag so the
        // claude process + every API call from it carries the no-claim hint.
        ...(ctx.no_claim ? [`export AIBALL_NO_CLAIM=1`] : []),
        // #480 david : le timer + les hooks sont spawn sans `cwd:` explicite
        // côté Node, donc ils héritent du cwd du shell de lancement
        // (typiquement le dev checkout aiball/). `loadConfig()` no-arg
        // tombait alors sur aiball/.aiball.yaml et les prompts FR d'aiball
        // fuyaient dans le wake de tous les autres loops. On expose le vrai
        // cwd projet (résolu via `canonicalCwd(ctx.cwd)` au start) ; chaque
        // appel à `loadConfig` côté loop le passe explicitement.
        `export AIBALL_PROJECT_CWD=${shQuote(cwd)}`,
        // #390: remote-daemon connection for the timer + hooks (they source
        // this file). Empty AIBALL_SOCK forces TCP — see the process.env
        // note above. Mirrors what we exported into process.env for the
        // claude session.
        ...(opts.aiballUrl
            ? [
                  `export AIBALL_URL=${shQuote(opts.aiballUrl)}`,
                  `export AIBALL_SOCK=`,
                  ...(opts.aiballToken ? [`export AIBALL_TOKEN=${shQuote(opts.aiballToken)}`] : []),
              ]
            : []),
        // #274: the PTY proxy paints the human-presence segment of the
        // tmux bar directly (instant on keystroke). It needs the session
        // target + the tmux binary to call `set-option @cl_human` /
        // `refresh-client`. Harmless when no proxy runs (degraded mode).
        `export ${CL_ENV.TMUX}=${shQuote(tmuxName(name))}`,
        `export MUX_CMD=${shQuote(MUX_CMD)}`,
        "",
    ];
    // #689 david `4hp9j6` — shell-env override transparent au start :
    // `CL_FOO=bar claude-loop start <name>` injecte la valeur du shell dans
    // le env file. Précédence : shell > yaml/flag/default. Identité (NAME /
    // STATE_DIR / TMUX / PINGS) exclue — c'est le start qui les calcule,
    // un override shell les casserait silencieusement.
    const overriddenEnvLines = applyShellOverrides(envLines);
    // #390: 0600 when the env file carries a bearer token — it's a secret
    // at rest. (Default perms otherwise, unchanged for local loops.)
    writeFileSync(
        envPath(sd),
        overriddenEnvLines.join("\n"),
        opts.aiballToken ? { mode: 0o600 } : undefined,
    );

    // Inline Claude Code settings JSON: register the Stop hook (which
    // execs the TS hook via tsx) for THIS session only — no
    // pollution of the user's ~/.claude/settings.json.
    const root = selfRoot();
    // NOTE (#B.178 win): claude-loop runs claude in a DETACHED mux pane
    // where nobody can answer claude's interactive first-run gates (the
    // ".mcp.json found — trust? [1/2/3]" menu, theme picker, "update
    // available", trust-folder, expired-login, …). Any such menu blocks
    // boot: claude sits at the prompt, the SessionStart hook never fires,
    // and the loop never progresses (looks "dead").
    //
    // PRIMARY TARGET (TODO): generic stuck-at-menu detection in the
    // timer — it already capture-pane's every tick, so it can notice
    // claude hasn't reached its ready prompt after boot-grace, surface
    // the offending menu (log + ping the human), and optionally send a
    // conservative key. That future-proofs against menus that don't
    // exist yet, instead of whack-a-mole per-menu settings flags
    // (enableAllProjectMcpServers etc. — rejected: also auto-trusts
    // EVERY project MCP server, a security footgun).
    //
    // INTERIM quick-win: the user runs `claude` once interactively in
    // the project dir to clear the one-time gates (documented in
    // docs/WIN-INSTALL.md). After that claude boots straight to its
    // prompt and claude-loop works.
    //
    // #B.228 (m2m crash): we used to wrap each hook in `npx --no-install
    // tsx`, but npx resolves `tsx` by walking up from the SPAWNED claude
    // process's cwd. When that cwd is a project without tsx in its own
    // node_modules (e.g. m2m), npx errors out with "npx canceled due
    // to missing packages and no YES option", the SessionStart hook
    // fails, and claude exits at boot (= the "barre reste jaune" bug
    // surfaced as "loop exits in ~30s"). Call tsx via the absolute path
    // inside the aiball install — bypasses npx's cwd-relative lookup.
    //
    // hookPath() forward-slashes the path on Windows. `join` yields a
    // backslash path there, and claude may run the hook command via
    // Git Bash (where a backslash command path is unreliable). Forward
    // slashes work in cmd.exe, Git Bash AND node/tsx, so they're safe
    // for both the tsx binary and the .ts script argument.
    const hookPath = (p: string) =>
        shQuote(process.platform === "win32" ? p.replace(/\\/g, "/") : p);
    const tsxBin = hookPath(join(root, "node_modules", ".bin", "tsx"));
    const stopHookCmd = `${tsxBin} ${hookPath(join(root, "src/claude-loop/stop-hook.ts"))}`;
    const sessionStartHookCmd = `${tsxBin} ${hookPath(join(root, "src/claude-loop/session-start-hook.ts"))}`;
    const userPromptSubmitHookCmd = `${tsxBin} ${hookPath(join(root, "src/claude-loop/user-prompt-submit-hook.ts"))}`;
    const askBlockHookCmd = `${tsxBin} ${hookPath(join(root, "src/claude-loop/pretooluse-hook.ts"))}`;
    const settings = {
        hooks: {
            // SessionStart fires once when claude has finished booting
            // — replaces the fragile `sleep 3 && send-keys` race the
            // wrapper used (#B.63 follow-up: david saw bugs when
            // claude was still prompting for MCP trust etc).
            //
            // #B.148 bug: matcher was "startup" only, so `claude
            // --resume` (which fires matcher="resume") and `claude
            // --continue`/"clear" (matcher="clear") bypassed the hook
            // entirely. Loop stayed idle even with pings unread because
            // SSE only delivers NEW pings (existing ones don't replay).
            // Register the same hook against each matcher so the
            // initial drain runs in every entry mode.
            SessionStart: [
                { matcher: "startup", hooks: [{ type: "command", command: sessionStartHookCmd }] },
                { matcher: "resume",  hooks: [{ type: "command", command: sessionStartHookCmd }] },
                { matcher: "clear",   hooks: [{ type: "command", command: sessionStartHookCmd }] },
            ],
            Stop: [{ hooks: [{ type: "command", command: stopHookCmd }] }],
            // UserPromptSubmit fires when the human (not the wrapper)
            // sends a prompt. Used to (a) suspend auto-pings for the
            // grace window so we don't send-keys over the human, and
            // (b) flip the tmux bar to `[busy]` immediately so the
            // display matches reality without waiting for the next
            // Stop tick (#B.145 v2.2).
            UserPromptSubmit: [{ hooks: [{ type: "command", command: userPromptSubmitHookCmd }] }],
            // PreToolUse on AskUserQuestion (#264): in an AUTONOMOUS loop
            // (no human in front) a multi-choice dialog stalls — nobody
            // clicks. The hook denies it ONLY when no human is taking
            // over and redirects the agent to ask via an aiball ticket
            // comment. Fail-open: human present (userIsTakingOver) or any
            // doubt → allow, so interactive sessions keep the feature.
            // Registered here (loop settings) so it's scoped to loops.
            PreToolUse: [
                { matcher: "AskUserQuestion", hooks: [{ type: "command", command: askBlockHookCmd }] },
            ],
        },
    };
    const settingsJson = JSON.stringify(settings);

    // claude passthrough args. Shell-escape per-arg so the inline
    // bash command keeps them intact.
    // #538 david `hwxbkk` : `claude.always_resume: true` injecte `--resume` si
    // pas déjà présent (ni la forme `--resume` ni `--resume=<x>` ni le
    // sentinel `--no-resume`). Idempotent — un user qui a déjà --resume
    // dans claudeArgs n'a pas un double flag. Namespacé `claude:` (et non
    // `claude_loop:`) parce que ça concerne le binaire claude lui-même.
    let effectiveClaudeArgs = opts.claudeArgs;
    // #616 — first-class `claude-loop --no-resume` flag (top-level, no `--`
    // dash-dash needed). Inject `--no-resume` into claudeArgs so the
    // always_resume detection below sees it as the sentinel and skips
    // the auto-inject. Same end-effect as `claude-loop start -- --no-resume`,
    // just a more discoverable per-invocation opt-out.
    if (opts.noResume && !opts.claudeArgs.includes("--no-resume")) {
        effectiveClaudeArgs = ["--no-resume", ...opts.claudeArgs];
    }
    // #639 david `uqdava` : `--resume` flag also forces `claude.always_resume`
    // to true regardless of yaml config (mirror of how `--no-resume` forces it
    // to false via the sentinel injection above).
    const alwaysResume = opts.forceResume ? true : ctx.claude.always_resume;
    if (alwaysResume) {
        const hasResume = effectiveClaudeArgs.some((a) => a === "--resume" || a.startsWith("--resume=") || a === "--no-resume");
        if (!hasResume) {
            // #616 follow-up (david arf8xs) : auto-skip --resume si AUCUNE
            // session claude n'existe pour ce cwd. Sinon, `claude --resume`
            // sur un projet vierge bloque sur le picker vide. La détection
            // est best-effort (lecture du dossier ~/.claude/projects/<encoded-cwd>)
            // — silencieusement skip à la moindre IO error : on retombe sur
            // le comportement précédent (--resume inject, claude se débrouille).
            if (!hasClaudeSessions(cwd)) {
                process.stdout.write(
                    `claude-loop: no prior claude session found for ${cwd} — skipping auto --resume (override with explicit --resume or --resume=<id>)\n`,
                );
            } else {
                effectiveClaudeArgs = ["--resume", ...effectiveClaudeArgs];
            }
        }
    }
    const passthrough = effectiveClaudeArgs.map(shQuote).join(" ");
    // CL_CLAUDE_CMD lets you swap the binary+flags (everything before
    // --settings) for debugging: see what the inner command receives
    // without claude repainting the screen. Useful values:
    //   bash -c 'echo "args: $*"; sleep 99' --
    //   bash -c 'cat <<< "$*"; read' --
    // Default = real claude. Read once at spawn time, baked into the
    // session's inner command (so a fresh `claude-loop start` picks
    // up the current env, but in-flight loops stay as-spawned).
    const claudeBin = process.env[CL_ENV.CLAUDE_CMD] ?? "claude --permission-mode auto";
    // IMPORTANT: no `{ … }` brace groups here. psmux interprets a
    // command starting with `{` as a PowerShell script block and
    // base64-UTF16-encodes it for `powershell -EncodedCommand`, which
    // then reaches bash as a bogus option and dies with
    // "invalid option name". Keep the inner command a flat sequence
    // of `;`-separated statements so psmux passes it through verbatim.
    // Pass --settings as a FILE PATH, not inline JSON. The settings
    // JSON contains double quotes, braces, backslash-escaped Windows
    // paths AND shQuote'd single quotes (from the hook command paths).
    // Passing that inline means it has to survive: shQuote → bash -lc
    // string → psmux argv reconstruction (node spawnSync builds a
    // Windows command line, psmux re-parses it). That round-trip
    // mangles the nested quoting on Windows and claude gets invalid
    // JSON → exits → pane dies → session reaped in ~30ms (#B.178 win).
    // A plain file path has none of those characters, so it round-trips
    // cleanly. claude's --settings accepts a path or inline JSON.
    const settingsFile = join(sd, "claude-settings.json");
    writeFileSync(settingsFile, settingsJson);
    // Merge #269 (PTY proxy) + #B.178 (win): build claudeCmd from the
    // file-based settings (Windows-safe) + CL_CLAUDE_CMD override; the
    // PTY-proxy block below wraps this claudeCmd and prepends `source env`.
    const claudeCmd =
        `${claudeBin} --settings ${shQuote(settingsFile)}` +
        (passthrough ? ` ${passthrough}` : "");
    // #269/#281: front claude with the PTY proxy so claude-loop detects
    // human typing live (busy included) and injects wakes through the
    // proxy's control channel instead of tmux/psmux stdin. Two backends:
    //   - Unix  → src/claude-loop/pty-proxy.py (Python stdlib, AF_UNIX).
    //     Requires python3; `-B` so no __pycache__ next to the proxy.
    //   - Windows → windows/cl-pty-proxy (Rust ConPTY, named pipe; #281
    //     strategy B). Built artifact, not committed — see WIN-INSTALL.md.
    //     Gated on platform (the Python proxy's pty/termios are POSIX-only
    //     and would crash the pane on Windows) AND on the .exe existing, so
    //     an un-built checkout cleanly falls back to direct claude.
    // Either proxy ALSO self-falls-back to exec-claude if PTY init fails —
    // the pane is never bricked. Missing proxy → launch claude directly.
    const pyProxy = join(root, "src/claude-loop/pty-proxy.py");
    const winProxyExe = join(root, "windows", "cl-pty-proxy", "target", "release", "cl-pty-proxy.exe");
    let launch: string;
    if (process.platform === "win32" && existsSync(winProxyExe)) {
        launch = `exec ${hookPath(winProxyExe)} -- ${claudeCmd}`;
    } else if (process.platform !== "win32" && has("python3") && existsSync(pyProxy)) {
        launch = `exec python3 -B ${shQuote(pyProxy)} -- ${claudeCmd}`;
    } else {
        launch = `exec ${claudeCmd}`;
    }
    const innerCmd = `source ${shQuote(envPath(sd))}; ${launch}`;

    const tname = tmuxName(name);
    // Resolve bash via absolute path on Windows. The user's PATH is
    // unreliable here: the WSL launcher (C:\Windows\System32\bash.exe)
    // sits in machine PATH and preempts Git Bash; and psmux's server
    // is persistent — once it started with a given PATH, subsequent
    // new-session calls use that PATH, not the caller's. Hardcoding
    // the Git Bash absolute path on Windows bypasses both issues —
    // BUT psmux splits the command at spaces when it rebuilds the
    // CreateProcess command line, so "C:\Program Files\…\bash.exe"
    // becomes "C:\Program" + bogus args. Convert to the 8.3 short
    // path (C:\PROGRA~1\…) which has no spaces.
    let bashCmd = "bash";
    if (process.platform === "win32") {
        const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if (existsSync(gitBash)) bashCmd = toShortPathWin(gitBash);
        // else fall back to "bash" and hope the PATH is sane.
    }
    // The `--` separator is REQUIRED for psmux: without it, psmux
    // collects the positional command args and joins them with spaces
    // into one string, which destroys the `bash -lc "<multi-word cmd>"`
    // arg boundaries (bash then runs just `source` and dies, killing
    // the pane → session reaped in seconds). With `--`, psmux keeps the
    // raw argv and execs it directly. Harmless on Linux tmux (standard
    // getopt end-of-options marker). Verified on Windows: `sleep` stays
    // alive with `--`, dies instantly without.
    const r = spawnSync(MUX_CMD, [
        "new-session", "-d", "-s", tname, "-c", cwd, "--", bashCmd, "-lc", innerCmd,
    ]);
    if (r.status !== 0) die("tmux new-session failed");

    // Status bar so a loop session is visually distinct. Initial
    // state is `boot` (yellow, transitional) — claude is loading,
    // hasn't reached the prompt yet, so `idle` would be misleading
    // (#B.149). SessionStart hook flips to idle/busy once claude is
    // actually ready. Color + label are driven by setTmuxStatus.
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "status-left-length", "90"], { stdio: "ignore" });
    // #381 → #385 (david qyqwnw): the control-key hint moves to `status-right`,
    // fully right-aligned ("met le hint complètement à droite"), uppercased, and
    // now also surfaces the tmux DETACH shortcut. The default host+date
    // status-right was useless for a loop pane, so this reclaims it. It's STATIC
    // (afk_key + tmux prefix don't change mid-session), seeded once here;
    // setTmuxStatus only ever rewrites status-left, so this survives every tick.
    // Colours mirror the left island: label dim (afk_label_fg), value in bar_fg,
    // both on the state-coloured status-bg.
    const afkKeyDisp = ctx.claude_loop.afk_key.trim().toUpperCase();
    // tmux DETACH = `<prefix> d` (default binding). Query the live prefix so the
    // hint is accurate; fall back to the tmux default C-b.
    const prefixRes = spawnSync(MUX_CMD, ["show-option", "-gv", "prefix"], { encoding: "utf8" });
    const detachDisp = `${(prefixRes.stdout ?? "").trim() || "C-b"} d`;
    // #619 jjfdea / 33zghr : the whole `AFK:F9` chunk is now painted by
    // the proxy via `#{@cl_afk_state}` so it can :
    //   - toggle the label colour ON (lit) / OFF (dim) by AFK state,
    //   - prepend a countdown (`9m AFK:F9`) or `∞ AFK:F9` while AFK is held,
    //   - render nothing extra when the loop is autonomous (just `AFK:F9`).
    // The proxy reads CL_AFK_KEY_DISP + CL_AFK_LABEL_FG_DIM/LIT from the
    // launch env (exported above) to know how to format the chunk. Initial
    // seed below renders an OFF state so the static format doesn't show a
    // bare `#{@cl_afk_state}` placeholder before the proxy paints.
    const afkInitialOff = afkSpecJson
        ? `#[fg=${ctx.colors.afk_label_fg}]AFK:#[fg=${ctx.colors.bar_fg}]${afkKeyDisp}`
        : `#[fg=${ctx.colors.afk_label_fg}]AFK:OFF`;
    const keysHint = `#{@cl_afk_state} #[fg=${ctx.colors.afk_label_fg}]· DETACH:#[fg=${ctx.colors.bar_fg}]${detachDisp} `;
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "status-right", keysHint], { stdio: "ignore" });
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "status-right-length", "60"], { stdio: "ignore" });
    // #619 david `ge2emb` : suppress the tmux window-status list (the
    // default `0:python3*` segment between status-left and status-right).
    // A claude-loop session has exactly one window with a process name we
    // don't pick, so the chip carries no useful signal — just visual noise
    // ("c'est quoi ? pour moi ça sert à rien"). window-status-format is a
    // WINDOW option, so scope to the loop window (-t tname targets it).
    spawnSync(MUX_CMD, ["set-window-option", "-t", tname, "window-status-format", ""], { stdio: "ignore" });
    spawnSync(MUX_CMD, ["set-window-option", "-t", tname, "window-status-current-format", ""], { stdio: "ignore" });
    // #776 david : on win32 the running binary is `cl-pty-proxy.exe` and
    // tmux's auto-rename leaks `0:cl-pty-proxy` into the bar despite the
    // empty window-status-format (terminal-emulator title bars + edge
    // tmux renderers ignore the suppression). Defense in depth : pin
    // the window name to empty + disable auto-rename so neither the
    // status format nor a terminal title can fall back to the binary.
    spawnSync(MUX_CMD, ["set-window-option", "-t", tname, "automatic-rename", "off"], { stdio: "ignore" });
    spawnSync(MUX_CMD, ["rename-window", "-t", tname, ""], { stdio: "ignore" });
    // #274 + #619 : seed the per-owner status segments so the static format
    // never renders an unset `#{@cl_*}` (empty is fine; unset shows literally
    // on some tmux). The proxy and setTmuxStatus take ownership from here.
    // #619 `zm2ehq` : seed @cl_human to `boot` (jaune) — the session opens
    // in boot phase and the proxy/timer will repaint to wait/loop on their
    // first tick. Avoids a flash of `loop` (vert) over the jaune boot bar.
    for (const [opt, val] of [["@cl_human", "#[fg=colour178,bg=colour16]boot"], ["@cl_proxy", ""], ["@cl_state", ""], ["@cl_afk_state", afkInitialOff]]) {
        spawnSync(MUX_CMD, ["set-option", "-t", tname, opt, val], { stdio: "ignore" });
        if (opt === "@cl_human") logBarPaint(sd, "cli.ts:seed", val);
    }
    // #281 strategy A: tell psmux to touch the human-typing marker natively
    // on real client keystrokes (busy included), via the same file
    // `humanIsTyping` reads. psmux >= the @human-input-marker feature acts on
    // it (psmux/psmux#309); older psmux + tmux just store the unknown option
    // and ignore it, so the pane-diff fallback still applies — no regression.
    // This is the no-nested-PTY path; complements the ConPTY proxy (strategy
    // B). See docs/PTY-PROXY-WINDOWS.md.
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "@human-input-marker", humanTypingPath(sd)], { stdio: "ignore" });
    // #B.176 (david): mouse mode ON for the session so the scroll
    // wheel actually scrolls the pane buffer instead of being
    // translated to Up/Down arrow keys. Scoped per-session — we
    // don't touch the user's global `.tmux.conf`.
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "mouse", "on"], { stdio: "ignore" });
    // #B.181 (david): with mouse-on, drag-select goes to tmux's paste
    // buffer instead of the terminal clipboard. Strategy: bind
    // MouseDragEnd1Pane to copy-pipe-no-clear piping into a real
    // local clipboard tool (wl-copy / xclip / pbcopy) when available —
    // robust across terminals including Ptyxis (VTE blocks OSC 52 by
    // default). `set-clipboard on` stays enabled as an SSH/remote
    // fallback path via OSC 52. `-no-clear` (vs `-and-cancel`) keeps
    // the visual selection on screen after mouse release so the user
    // can see what was copied.
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "set-clipboard", "on"], { stdio: "ignore" });
    const clipboardCmd = resolveClipboardCmd();
    const pipeArgs = clipboardCmd
        ? ["send-keys", "-X", "copy-pipe-no-clear", clipboardCmd]
        : ["send-keys", "-X", "copy-pipe-no-clear"];
    spawnSync(MUX_CMD, [
        "bind-key", "-T", "copy-mode", "MouseDragEnd1Pane",
        ...pipeArgs,
    ], { stdio: "ignore" });
    setTmuxStatus(name, LOOP_STATUS.BOOT);

    // Detached timer process. Inherits CL_* env via the env file
    // sourced in the child shell. nohup-like: ignore SIGHUP, detach.
    const logFd = openSync(timerLogPath(sd), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    const child = spawn("bash", [
        "-lc",
        // #B.228 defensive: same fix as the hook commands above —
        // call tsx via its absolute path so the timer can be respawned
        // from any cwd (relevant for `claude-loop reload` called from a
        // project dir without tsx in its node_modules).
        `source ${shQuote(envPath(sd))} && exec ${tsxBin} ${shQuote(timerScript)}`,
    ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    writeFileSync(timerPidPath(sd), String(child.pid) + "\n");

    // No more sleep+send-keys race for the startup ping — handled
    // by src/claude-loop/session-start-hook.ts which fires when the
    // session is actually ready and gates on the same check-cmd
    // (see SessionStart entry in the inline settings JSON above).
    // pickPingPhrase still used by the hook + the timer.
    void pickPingPhrase;

    // Default behavior: attach. David: "par défaut claude-loop
    // devrait s'attacher (on peut faire un flag inversé)".
    // `--no-attach` opts out → wrapper exits, user re-attaches later.
    if (opts.attach === false) {
        process.stdout.write([
            `loop '${name}' started (detached)`,
            `  state:    ${sd}`,
            `  interval: ${interval}s`,
            `  claude:   claude --permission-mode auto${passthrough ? " " + passthrough : ""}`,
            `  attach:   ${MUX_CMD} attach -t ${tname}   (or: claude-loop attach ${name})`,
            "",
        ].join("\n"));
        return;
    }
    process.stdout.write(`loop '${name}' started — attaching... (Ctrl-B D to detach)\n`);
    spawnSync(MUX_CMD, ["attach", "-t", tname], { stdio: "inherit" });
}

/**
 * #410 (david) — lit le pid du timer détaché depuis timer.pid (null si
 * absent/illisible) + sonde sa liveness (signal 0). Le timer.pid est le pid
 * qu'on cible avec `kill -HUP`/`-USR2` ; l'afficher au listing permet aussi
 * de repérer un pidfile périmé (timer mort alors que le tmux tourne → plus
 * d'auto-wake), à l'origine des timers orphelins déjà vus.
 */
function readTimerPid(sd: string): number | null {
    const p = timerPidPath(sd);
    if (!existsSync(p)) return null;
    const pid = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function cmdList(): void {
    if (!existsSync(STATE_ROOT)) {
        process.stdout.write("(no loops)\n");
        return;
    }
    // #B.225 ghost detection: compute the install-root SHA once for the
    // whole listing so each plate's stamped sha can be diffed against
    // it. Null when not a git checkout — we just skip the stale chip.
    const currentSha = installRootSha();
    const entries = readdirSync(STATE_ROOT).sort();
    let found = 0;
    let staleCount = 0;
    for (const name of entries) {
        const sd = stateDirFor(name);
        if (!existsSync(platePath(sd))) continue;
        let plate: Plate;
        try { plate = readPlate(sd); } catch { continue; }
        const alive = tmuxAlive(name);
        const aliveStr = alive ? "alive" : "dead";
        const idle = existsSync(idleMarkerPath(sd))
            ? `idle since ${readFileSync(idleMarkerPath(sd), "utf8").trim()}`
            : "—";
        // Stale only matters for alive loops — a dead loop's timer is
        // gone, restart picks up current source by definition.
        const stale = alive && isLoopStale(plate);
        const staleTag = stale ? " [stale]" : "";
        if (stale) staleCount++;
        // #410 — pid du timer détaché (kill -HUP/-USR2 target). " (dead)" =
        // pidfile périmé ; "—" = pas de pidfile.
        const timerPid = readTimerPid(sd);
        const pidCol = timerPid == null
            ? "pid —"
            : `pid ${timerPid}${pidAlive(timerPid) ? "" : " (dead)"}`;
        process.stdout.write(
            `${name.padEnd(24)}  ${aliveStr.padEnd(5)}${staleTag.padEnd(8)}  ${pidCol.padEnd(16)}  ${plate.interval}s  ${idle}\n`,
        );
        process.stdout.write(`${"".padEnd(24)}  dir=${plate.cwd}\n`);
        if (stale && plate.started_at_sha && currentSha) {
            process.stdout.write(
                `${"".padEnd(24)}  source has moved since boot: ${plate.started_at_sha.slice(0, 7)} → ${currentSha.slice(0, 7)} (reload to pick up changes)\n`,
            );
        }
        found++;
    }
    if (found === 0) process.stdout.write("(no loops)\n");
    if (staleCount > 0) {
        process.stdout.write(
            `\n${staleCount} stale loop${staleCount === 1 ? "" : "s"} detected — run \`claude-loop reload <name>\` to reload source in place (keeps the claude conversation; loops also auto-reload at their next idle tick).\n`,
        );
    }
}

function cmdAttach(name: string | undefined): void {
    // #415 (david) : `claude-loop attach` sans nom → résout le loop unique
    // du cwd courant (même convention que tail/reload/restart/check).
    // resolveCurrentLoopName privilégie déjà l'alive sur égalité et meurt
    // avec un message de désambiguïsation si plusieurs loops partagent le cwd.
    const resolved = name ?? resolveCurrentLoopName();
    if (!tmuxAlive(resolved)) die(`loop '${resolved}' not alive`);
    spawnSync(MUX_CMD, ["attach", "-t", tmuxName(resolved)], { stdio: "inherit" });
}



// Format the "project cwd" reporter line for `check` / `status`. When a
// named loop's plate is in hand, prefer its cwd (it's the canonical
// source for that loop, and what the timer will actually use). Otherwise
// resolve from the live env (AIBALL_PROJECT_CWD → CL_STATE_DIR's plate
// → process.cwd()).
function formatProjectCwd(name: string | undefined, plate: Plate | null): string {
    if (plate?.cwd) {
        const tag = plate.name ?? name ?? "?";
        return `${plate.cwd} (from plate.json — loop '${tag}')`;
    }
    const info = projectCwdInfo();
    switch (info.source) {
        case "env":   return `${info.cwd} (from env AIBALL_PROJECT_CWD)`;
        case "plate": return `${info.cwd} (from plate.json — CL_STATE_DIR=${info.state_dir})`;
        case "cwd":   return `${info.cwd} (from process.cwd())`;
    }
}

/**
 * Diagnostic subcommand (#B.149). Answers "what would the timer do
 * right now?" without spawning claude. Useful when a fresh ticket
 * isn't being picked up — surfaces whether the resolved consumer_id /
 * project actually sees pings for the work the user expects.
 *
 * Pulls config from (in order): the named loop's plate.json (if a
 * `name` is passed and the loop exists), then process env (CL_*,
 * AIBALL_AGENT, AIBALL_PROJECT), then defaults. Prints the resolved
 * settings, runs `checkHasWork`, and for the default aiball check
 * also breaks down the ping counters so the cause of a 0 is visible
 * (wrong agent? wrong project? actually no pings?).
 */
async function cmdCheck(name: string | undefined, opts: { checkCmd?: string; config?: boolean }): Promise<void> {
    const ctx = resolveProjectContext();
    applyToProcessEnv(ctx);
    warnIfDeprecated(ctx);
    let plateCheckCmd: string | undefined;
    let plateName: string | undefined;
    let plate: Plate | null = null;
    if (name) {
        const sd = stateDirFor(name);
        if (existsSync(platePath(sd))) {
            try {
                plate = readPlate(sd);
                plateCheckCmd = plate.check_cmd;
                plateName = plate.name;
            } catch { /* ignore */ }
        }
    }
    const checkCmd = opts.checkCmd ?? plateCheckCmd ?? process.env[CL_ENV.CHECK_CMD] ?? DEFAULT_CHECK_CMD;
    process.stdout.write(`claude-loop check\n`);
    process.stdout.write(`  loop name      : ${plateName ?? name ?? "(no loop)"}\n`);
    process.stdout.write(`  check-cmd      : ${checkCmd}\n`);
    process.stdout.write(`  AIBALL_AGENT   : ${ctx.agent} (from ${ctx.agent_source})\n`);
    process.stdout.write(`  AIBALL_PROJECT : ${ctx.project ?? "(unset)"}\n`);
    if (ctx.config_path) {
        process.stdout.write(`  .aiball.yaml   : ${ctx.config_path}\n`);
    }
    process.stdout.write(`  project cwd    : ${formatProjectCwd(name, plate)}\n`);
    // #269/#281 (david ftprf7): surface the PTY-proxy dependency. The proxy
    // gives live human-typing detection (busy included) + control-channel
    // wake injection. When inactive, `start` falls back to launching claude
    // directly (pane-diff detection, idle-only) — flag it here, same probe
    // the launch uses. Windows = Rust ConPTY proxy (#281 strategy B); Unix =
    // Python proxy (needs python3 + the shipped script).
    if (process.platform === "win32") {
        const winProxyExe = join(selfRoot(), "windows", "cl-pty-proxy", "target", "release", "cl-pty-proxy.exe");
        const hasWinProxy = existsSync(winProxyExe);
        process.stdout.write(`  ConPTY proxy   : ${
            hasWinProxy
                ? "✓ active (live human-typing detection + named-pipe wake injection)"
                : "— inactive → fallback direct launch (cl-pty-proxy.exe not built — run `cargo build --release` in windows/cl-pty-proxy); pane-diff detection, idle-only"
        }\n`);
    } else {
        const hasPython = commandExists("python3");
        const proxyScript = join(selfRoot(), "src/claude-loop/pty-proxy.py");
        const hasProxyScript = existsSync(proxyScript);
        const proxyActive = hasPython && hasProxyScript;
        process.stdout.write(`  python3        : ${hasPython ? "✓ available" : "— MISSING"}\n`);
        process.stdout.write(`  PTY proxy      : ${
            proxyActive
                ? "✓ active (live human-typing detection + socket wake injection)"
                : `— inactive → fallback direct launch (${hasPython ? "proxy script missing" : "python3 missing"}); pane-diff detection, idle-only`
        }\n`);
    }
    process.stdout.write(`\n`);

    // #B.149: --config flag inspects the loop's state dir + the
    // working dir for autopoll wiring so david can spot a missing
    // .aiball.yaml or a hook that didn't register without having to
    // dig into ~/.claude-loop/ by hand.
    if (opts.config) {
        if (!name) {
            process.stdout.write(`  config check needs a loop name (claude-loop check <name> --config)\n`);
        } else {
            const sd = stateDirFor(name);
            process.stdout.write(`  state dir: ${sd}\n`);
            for (const f of ["plate.json", "env", "pings.yaml", "idle-since", "wake-requested", "timer.pid", "timer.log"]) {
                const p = join(sd, f);
                process.stdout.write(`    ${f.padEnd(18)}  ${existsSync(p) ? "✓" : "—"}\n`);
            }
            if (plate) {
                process.stdout.write(`\n  plate.json contents:\n`);
                process.stdout.write(`    interval     : ${plate.interval}s\n`);
                process.stdout.write(`    pings_path   : ${plate.pings_path}\n`);
                process.stdout.write(`    cwd          : ${plate.cwd}\n`);
                process.stdout.write(`    claude_args  : ${plate.claude_args.length === 0 ? "(none)" : plate.claude_args.join(" ")}\n`);
                // #B.225 ghost detection: surface stamped SHA + diff vs
                // current install-root HEAD so a stale daemon is
                // visible without grepping plate.json by hand.
                const stamped = plate.started_at_sha ?? null;
                const current = installRootSha();
                process.stdout.write(`    started_at_sha: ${stamped ?? "(unset — pre-#B.225 loop)"}\n`);
                if (stamped && current && stamped !== current) {
                    process.stdout.write(`    !! source has moved since boot: ${stamped.slice(0, 7)} → ${current.slice(0, 7)} (restart to reload)\n`);
                } else if (stamped && current && stamped === current) {
                    process.stdout.write(`    install-root HEAD: ${current.slice(0, 7)} (in sync)\n`);
                }
            }
            const cwd = plate?.cwd ?? process.cwd();
            const aiballYaml = join(cwd, ".aiball.yaml");
            process.stdout.write(`\n  ${aiballYaml}: ${existsSync(aiballYaml) ? "✓ present" : "— missing (autopoll Stop-hook won't fire here)"}\n`);
        }
        process.stdout.write(`\n`);
    }

    // Internal SDK mode (default or legacy sentinel) → dump the
    // rich snapshot so the cause of a 0 is visible without re-
    // running curl by hand.
    if (isInternalCheckCmd(checkCmd)) {
        try {
            const client = new AiballClient();
            const [ping, subs, projects] = await Promise.all([
                client.pingsCount() as Promise<{ consumer_id: string; unread: number }>,
                client.mySubs() as Promise<Array<{
                    project?: string;
                    role?: string;
                    ticket_id?: number;
                }>>,
                client.listProjectsDetailed().catch(() => []) as Promise<Array<{
                    name: string;
                    open_count?: number;
                    actionable_count?: number;
                }>>,
            ]);
            const openCount = Array.isArray(projects)
                ? projects
                    .filter((p) => !ctx.project || p.name === ctx.project)
                    .reduce((acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0), 0)
                : 0;
            process.stdout.write(`  resolved consumer_id  : ${ping.consumer_id}\n`);
            process.stdout.write(`  unread pings (this consumer): ${ping.unread}\n`);
            process.stdout.write(`  open tickets (actionable${ctx.project ? `, project=${ctx.project}` : ", all subs"}): ${openCount}\n`);
            const projectSubs = subs.filter((s) => s.project && !s.ticket_id);
            process.stdout.write(`  project subscriptions :\n`);
            if (projectSubs.length === 0) {
                process.stdout.write(`    (none — consumer subscribes to NO project; new tickets won't generate pings for this consumer in any project)\n`);
            } else {
                for (const s of projectSubs) {
                    process.stdout.write(`    ${(s.project ?? "?").padEnd(24)}  role=${s.role ?? "(?)"}\n`);
                }
            }
            process.stdout.write(`\n`);
            const hasWork = ping.unread > 0 || openCount > 0;
            const verdictReason = ping.unread > 0 && openCount > 0
                ? "pings + open tickets"
                : ping.unread > 0
                    ? "pings to drain"
                    : openCount > 0
                        ? "open tickets to handle"
                        : "nothing";
            const verdict = hasWork ? `WAKE (${verdictReason})` : "SLEEP (nothing)";
            process.stdout.write(`  verdict: ${verdict}\n`);
            const hasProjectSub = ctx.project !== null && projectSubs.some((s) => s.project === ctx.project);
            if (ctx.project && !hasProjectSub) {
                process.stdout.write(`  hint   : AIBALL_PROJECT=${ctx.project} is set but consumer '${ping.consumer_id}' has NO subscription on that project — new tickets there won't generate pings. Fix: subscribe via MCP \`subscribe({project: "${ctx.project}", role: "owner"})\` while running AS this consumer.\n`);
            }
            if (projectSubs.length === 0) {
                process.stdout.write(`  hint   : consumer '${ping.consumer_id}' looks ephemeral (random fallback?). Set AIBALL_AGENT to a stable id and subscribe it to the projects you care about.\n`);
            }
            process.exit(hasWork ? 0 : 1);
        } catch (e) {
            process.stderr.write(`  ERROR: ${(e as Error).message ?? String(e)}\n`);
            process.exit(2);
        }
    } else {
        // Custom check-cmd → shell out, report exit code.
        const r = spawnSync("bash", ["-c", checkCmd], { stdio: ["ignore", "inherit", "inherit"] });
        process.stdout.write(`\n`);
        const verdict = r.status === 0 ? "WAKE (exit 0)" : `SLEEP (exit ${r.status})`;
        process.stdout.write(`  verdict: ${verdict}\n`);
        process.exit(r.status ?? 2);
    }
}

/**
 * `claude-loop status [name]` (#444). Project-level snapshot: the resolved
 * identity (project + default agent, with where each came from), the loaded
 * `.aiball.yaml`, and — david's main ask — the **connection type** the aiball
 * client would use right now (local Unix socket vs remote HTTP, token or not),
 * plus a live daemon-reachability probe. Read-only; never touches loop state.
 *
 * Distinct from `check` (which answers "what would the timer do — pings/subs/
 * verdict"): `status` answers "who am I and how do I reach the daemon",
 * cheaply. The transport is resolved purely from env by AiballClient
 * (AIBALL_SOCK > AIBALL_URL/AIBALL_TOKEN), so we build one the same way the
 * loop/MCP would and report what it WOULD pick — the honest "type de connexion".
 */
async function cmdStatus(name: string | undefined): Promise<void> {
    const ctx = resolveProjectContext();
    applyToProcessEnv(ctx);
    warnIfDeprecated(ctx);

    let statusPlate: Plate | null = null;
    if (name) {
        const sd = stateDirFor(name);
        if (existsSync(platePath(sd))) {
            try { statusPlate = readPlate(sd); } catch { /* ignore */ }
        }
    }

    process.stdout.write(`claude-loop status\n`);
    process.stdout.write(`  project        : ${ctx.project} (from ${ctx.project_source})\n`);
    process.stdout.write(`  default agent  : ${ctx.agent} (from ${ctx.agent_source})\n`);
    // #508 phase A2 `qqdh4p` — surfaces le flag no_claim du project yaml.
    // Quand vrai : engage skip le pool global et ne prend que les tickets
    // explicitement assignés. claude-loop exporte AIBALL_NO_CLAIM=1 vers
    // claude + hooks → AiballClient inject `x-aiball-no-claim: 1`.
    process.stdout.write(`  no_claim       : ${ctx.no_claim ? "true (assignment-only — engage skips the global pool)" : "false (claim normally)"}\n`);
    // #624 david `j3zzxg` : surface the wait mode so a launched loop can be
    // inspected without parsing the env file. `wait: true` (managed) =
    // boot-grace honored + post-boot armed NOT AFK 10m. `wait: false`
    // (--no-wait, default per project yaml) = eager drain at boot end.
    process.stdout.write(`  wait           : ${ctx.claude_loop.wait ? "true (--wait — boot-grace honored, post-boot arms NOT AFK 10m)" : "false (--no-wait — eager drain at boot end, post-boot bar `loop`)"}\n`);
    // #591 qef8m6 — surface project_type so it's visible from the CLI without
    // calling the welcome MCP. Null = welcome falls back to `public`.
    process.stdout.write(`  project_type   : ${ctx.project_type ?? "(unset — welcome defaults to 'public')"}\n`);
    process.stdout.write(`  .aiball.yaml   : ${ctx.config_path ?? "(none — built-in defaults)"}\n`);
    process.stdout.write(`  project cwd    : ${formatProjectCwd(name, statusPlate)}\n`);

    const client = new AiballClient({ agentId: ctx.agent, defaultProject: ctx.project });
    let connection: string;
    let endpoint: string;
    if (client.socketPath) {
        connection = "local — Unix socket (local-trust, no token)";
        endpoint = client.socketPath;
    } else if (client.token) {
        connection = "remote — HTTP + bearer token";
        endpoint = client.url;
    } else {
        // No token over TCP: fine for a loopback daemon (local trust at the
        // OS level), but a non-loopback host with no token won't authenticate.
        let loopback = false;
        try { loopback = ["127.0.0.1", "localhost", "::1"].includes(new URL(client.url).hostname); }
        catch { /* malformed url — leave loopback=false */ }
        connection = loopback
            ? "local — HTTP loopback (no token)"
            : "remote — HTTP, NO token (won't authenticate unless the daemon is open)";
        endpoint = client.url;
    }
    process.stdout.write(`  connection     : ${connection}\n`);
    process.stdout.write(`  endpoint       : ${endpoint}\n`);

    // Live reachability probe (client default timeout = 2s). Surfaces the
    // daemon's version so a stale/ahead daemon vs this CLI is visible.
    let daemon: string;
    try {
        const h = await client.health();
        daemon = `✓ reachable${h.version ? ` (aiball ${h.version})` : ""}`;
    } catch (e) {
        daemon = `✗ unreachable (${(e as Error).message ?? String(e)})`;
    }
    process.stdout.write(`  daemon         : ${daemon}\n`);
    process.stdout.write(`  client version : aiball ${AIBALL_VERSION}\n`);

    // Best-effort: a registered loop for this cwd (read-only, never dies).
    const loops = name
        ? loopsForCwd().filter((l) => l.name === name)
        : loopsForCwd();
    if (loops.length === 0) {
        process.stdout.write(`  loop @ cwd     : ${name ? `'${name}' not registered here` : "none registered for this cwd"}\n`);
    } else {
        process.stdout.write(`  loop @ cwd     : ${
            loops.map((l) => `${l.name} (${l.alive ? "alive" : "dead — state kept"})`).join(", ")
        }\n`);
    }
}

/**
 * Dummy/observe subcommand (#B.149). Runs the timer's gate logic in
 * the foreground without spawning claude or a tmux session — david:
 * "un mode dummy qui permet de savoir ce qui devrait se passer
 * (claude-loop sans claude)". Each iteration prints whether the
 * wrapper WOULD wake claude right now, and why.
 *
 * Unlike `check` (one-shot), `trace` loops every `interval` seconds
 * until Ctrl-C. Useful for "I just created a ticket — does the loop
 * see it?" debugging in real time. No state written, no tmux, no
 * claude subprocess; you can run as many `trace` sessions in parallel
 * as you want.
 */
async function cmdTrace(opts: { checkCmd?: string; interval?: string; once?: boolean; events?: boolean }): Promise<void> {
    const ctx = resolveProjectContext();
    applyToProcessEnv(ctx);
    warnIfDeprecated(ctx);
    // --events mode (#B.154): open SSE and print every aiball event
    // live. Pure tail — no gate eval, no decision making, just observe
    // what the daemon would push to this consumer. Useful to verify
    // "is my consumer actually wired to receive events for this
    // project?" without involving claude-loop's timer logic.
    if (opts.events) {
        const client = new AiballClient();
        process.stdout.write(`claude-loop trace --events — tailing aiball SSE\n`);
        process.stdout.write(`(consumer=${client.agentId}, Ctrl-C to exit)\n\n`);
        const off = client.subscribeEvents({
            onHello: (p) => process.stdout.write(`[${new Date().toISOString()}] hello: consumer=${p.consumer_id} unread=${p.unread}\n`),
            onPing: (p) => process.stdout.write(`[${new Date().toISOString()}] PING ${JSON.stringify(p)}\n`),
            onError: (e) => process.stdout.write(`[${new Date().toISOString()}] error: ${e.message}\n`),
        });
        await new Promise<void>((res) => {
            process.on("SIGINT", () => { off(); res(); });
            process.on("SIGTERM", () => { off(); res(); });
        });
        return;
    }

    const checkCmd = opts.checkCmd ?? process.env[CL_ENV.CHECK_CMD] ?? DEFAULT_CHECK_CMD;
    const interval = Math.max(1, Number(opts.interval ?? 10));
    process.stdout.write(`claude-loop trace — check-cmd=${checkCmd}, interval=${interval}s\n`);
    process.stdout.write(`(no claude spawn, no tmux session — Ctrl-C to exit)\n\n`);
    let aiballClient: AiballClient | null = null;
    let tick = 0;
    const once = opts.once === true;
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
     
    while (true) {
        tick += 1;
        const ts = new Date().toISOString();
        if (isInternalCheckCmd(checkCmd)) {
            if (!aiballClient) aiballClient = new AiballClient();
            try {
                const [r, projects] = await Promise.all([
                    aiballClient.pingsCount() as Promise<{ consumer_id: string; unread: number }>,
                    aiballClient.listProjectsDetailed().catch(() => []) as Promise<Array<{
                        name: string;
                        open_count?: number;
                        actionable_count?: number;
                    }>>,
                ]);
                const openCount = Array.isArray(projects)
                    ? projects
                        .filter((p) => !ctx.project || p.name === ctx.project)
                        .reduce((acc, p) => acc + (p.actionable_count ?? p.open_count ?? 0), 0)
                    : 0;
                const hasWork = r.unread > 0 || openCount > 0;
                const verdict = hasWork ? "WAKE" : "sleep";
                process.stdout.write(`[${ts}] tick ${tick}: consumer=${r.consumer_id} unread=${r.unread} open=${openCount} → ${verdict}\n`);
            } catch (e) {
                process.stdout.write(`[${ts}] tick ${tick}: ERROR ${(e as Error).message ?? String(e)} → sleep\n`);
            }
        } else {
            const r = spawnSync("bash", ["-c", checkCmd], { stdio: "ignore" });
            const verdict = r.status === 0 ? "WAKE" : "sleep";
            process.stdout.write(`[${ts}] tick ${tick}: exit=${r.status} → ${verdict}\n`);
        }
        if (once) return;
        await sleep(interval * 1000);
    }
}


/**
 * Debug subcommand (#381 yf8wht, david "un outil qui lit directement les touches
 * et qui donne la syntaxe dans notre grammaire"). Reads raw keystrokes STRAIGHT
 * from this terminal (no PTY, no tmux, no claude) and prints, per keystroke, the
 * hex bytes + the decoded afk_key grammar (`alt+esc`, `ctrl+g`, …) + whether it
 * matches the configured afk_key. The direct test for david's hypothesis "alt+esc
 * est intercepté par gnome": press the combo — if NOTHING prints, the window
 * manager / terminal swallowed it before aiball ever saw the bytes. Quit: Ctrl-C.
 */
function cmdDebugKeys(): void {
    const ctx = resolveProjectContext();
    let spec: AfkSpec | null = null;
    try {
        spec = parseAfkKey(ctx.claude_loop.afk_key, ctx.claude_loop.afk_window_ms);
    } catch (e) {
        process.stderr.write(
            `claude-loop: invalid afk_key "${ctx.claude_loop.afk_key}" — match column disabled (${(e as Error).message})\n`,
        );
    }
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        die("debug-keys: stdin is not a TTY — run it directly in a real terminal (the same one you use for the loop).");
    }
    process.stdout.write([
        `claude-loop debug-keys`,
        `  afk_key : "${ctx.claude_loop.afk_key}"  → combos ${spec ? JSON.stringify(spec.combos) : "(disabled)"}`,
        ``,
        `Reads keys DIRECTLY from this terminal (no PTY / tmux / claude). Per key:`,
        `  <hex bytes>   →   <grammar>   [✓ matches afk_key → would TOGGLE]`,
        `Press your AFK combo (e.g. alt+esc). If NOTHING prints, the window manager`,
        `or terminal ate it before aiball could see the bytes — that's the #381 cause.`,
        `Quit: Ctrl-C.`,
        ``,
    ].join("\n"));
    stdin.setRawMode(true);
    stdin.resume();
    const restore = (): void => { try { stdin.setRawMode(false); } catch { /* already gone */ } };
    process.on("exit", restore);
    stdin.on("data", (buf: Buffer) => {
        const bytes = Array.from(buf);
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
        const grammar = bytesToGrammar(bytes);
        // Ctrl-C (lone 0x03) quits — show it decoded first, then bail.
        if (bytes.length === 1 && bytes[0] === 0x03) {
            process.stdout.write(`  ${hex.padEnd(16)} →  ${grammar}   (quit)\n`);
            restore();
            process.exit(0);
        }
        const hit = spec && matchAfkCombo(bytes, spec) ? "   ✓ matches afk_key → would TOGGLE" : "";
        process.stdout.write(`  ${hex.padEnd(16)} →  ${grammar}${hit}\n`);
    });
}

/**
 * Debug subcommand (#381, david "--debug-proxy-tty"). Runs the REAL PTY proxy
 * attached to the current terminal, but with a FAKE claude (a byte logger)
 * behind it instead of claude. Lets you mash keys and see, LIVE:
 *   - each physical os.read (byte count + hex),
 *   - how `split_keystrokes` splits it into keystrokes (coalescing flagged),
 *   - the per-keystroke AFK decision (fired? afk away/back? forwarded bytes?),
 *   - what actually reaches "claude" (the fake logger's output).
 * The AFK spec/window/esc_takeover come from the resolved config, identical to
 * `start`, so the detector behaves exactly as in production. Captures a raw
 * NDJSON to a temp file (replayable via `pty-proxy.py --replay-log`) and prints
 * a summary on exit. Answers david's #381 question directly: does a single ESC
 * press read as `1b` or `1b1b` (key-repeat coalescing)?
 */
async function cmdDebugProxyTty(): Promise<void> {
    if (process.platform === "win32") {
        die("debug-proxy-tty: Unix only (Python PTY proxy). Windows uses the ConPTY proxy.");
    }
    need("python3");
    const root = selfRoot();
    const pyProxy = join(root, "src/claude-loop/pty-proxy.py");
    if (!existsSync(pyProxy)) die(`pty-proxy.py not found at ${pyProxy}`);
    const ctx = resolveProjectContext();
    // Same afk_key → byte-combo resolution as `start` (#351) so the detector
    // under test is byte-for-byte the production one.
    let afkSpecJson = "";
    try {
        afkSpecJson = JSON.stringify(
            parseAfkKey(ctx.claude_loop.afk_key, ctx.claude_loop.afk_window_ms).combos,
        );
    } catch (e) {
        process.stderr.write(`claude-loop: invalid afk_key "${ctx.claude_loop.afk_key}" — AFK disabled (${(e as Error).message})\n`);
    }
    // Isolated temp state dir + raw capture — never collides with a live loop.
    const tmp = mkdtempSync(join(tmpdir(), "cl-debug-proxy-"));
    const capture = join(tmp, "capture.ndjson");
    const env = {
        ...process.env,
        [CL_ENV.STATE_DIR]: tmp,
        [CL_ENV.AFK_SPEC]: afkSpecJson,
        [CL_ENV.AFK_WINDOW_MS]: String(ctx.claude_loop.afk_window_ms),
        [CL_ENV.ESC_TAKEOVER]: ctx.claude_loop.esc_takeover ? "1" : "0",
        [CL_ENV.WAIT]: "0",
        [CL_ENV.PROXY_LOG]: capture,
        [CL_ENV.PROXY_DEBUG_TTY]: "1",
        // No CL_TMUX → the proxy's bar painting is a silent no-op here.
    };
    process.stdout.write([
        `claude-loop debug-proxy-tty`,
        `  afk_key : "${ctx.claude_loop.afk_key}"  (window ${ctx.claude_loop.afk_window_ms}ms, esc_takeover ${ctx.claude_loop.esc_takeover})`,
        `  spec    : ${afkSpecJson || "(AFK disabled — empty/invalid afk_key)"}`,
        ``,
        `Real PTY proxy in front of a FAKE claude (byte logger). Type/mash keys and`,
        `watch, live: each physical read, how it splits, and the AFK decision.`,
        `Things worth trying: your AFK combo; a lone ESC; mash ESC twice; HOLD ESC`,
        `(key-repeat). The combo is SWALLOWED (won't reach the logger) — expected.`,
        `Quit with Ctrl-C.`,
        ``,
    ].join("\n"));
    const r = spawnSync("python3", ["-B", pyProxy, "--", "python3", "-B", pyProxy, "--fake-claude"], {
        stdio: "inherit",
        env,
    });
    printDebugProxySummary(capture);
    process.stdout.write(
        `\nraw capture : ${capture}\n` +
        `  replay it : python3 ${pyProxy} --replay-log ${capture}\n`,
    );
    process.exit(r.status ?? 0);
}

/**
 * Post-session summary for `debug-proxy-tty`. Reads the raw NDJSON capture and
 * counts physical reads (consecutive `stdin` events share a timestamp when they
 * came from one os.read), how many carried >1 keystroke (coalescing — the #381
 * ambiguity), and how many AFK toggles fired. Flags the smoking gun when a
 * single read produced multiple keystrokes.
 */
function printDebugProxySummary(capture: string): void {
    if (!existsSync(capture)) { process.stdout.write(`\n(no keystrokes captured)\n`); return; }
    let lines: Array<{ t: number; event: string; afk_fired: boolean }>;
    try {
        lines = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean)
            .map((l) => JSON.parse(l));
    } catch { return; }
    const stdin = lines.filter((l) => l.event === "stdin");
    if (stdin.length === 0) { process.stdout.write(`\n(no keystrokes captured)\n`); return; }
    let reads = 0, coalesced = 0, toggles = 0, inRead = 0;
    let prevT: number | null = null;
    for (const l of stdin) {
        if (l.afk_fired) toggles++;
        if (l.t !== prevT) { if (inRead > 1) coalesced++; reads++; inRead = 1; prevT = l.t; }
        else inRead++;
    }
    if (inRead > 1) coalesced++;
    process.stdout.write(`\n=== session summary ===\n`);
    process.stdout.write(`  physical reads : ${reads}\n`);
    process.stdout.write(`  coalesced reads: ${coalesced}  (one read carrying >1 keystroke)\n`);
    process.stdout.write(`  AFK toggles    : ${toggles}\n`);
    if (coalesced > 0) {
        process.stdout.write(
            `  ⚠ a single physical read carried multiple keystrokes — that key-repeat/\n` +
            `    coalescing is exactly the #381 ambiguity (a held/repeated ESC reads as\n` +
            `    1b1b → splits into two ESC → completes the esc-esc combo → toggles).\n`,
        );
    }
}

// Commander wiring. `start` is the default — bare `claude-loop` (or
// `claude-loop --name foo -- --model opus`) runs start. Anything
// after `--` is captured as claude_args.
function splitClaudeArgs(argv: string[]): { wrapper: string[]; passthrough: string[] } {
    const idx = argv.indexOf("--");
    if (idx === -1) return { wrapper: argv, passthrough: [] };
    return { wrapper: argv.slice(0, idx), passthrough: argv.slice(idx + 1) };
}

/**
 * #394 volet A: persist a REMOTE aiball connection to `<cwd>/.aiball.local.yaml`
 * so a plain `claude-loop start` (no flags) slaves to it. Folded into
 * `claude-loop init` (which also bootstraps the project) — runs only when
 * `--aiball-url` is passed. The file carries a token → chmod 600, git-ignored.
 * Per-start flags still override per-launch.
 */
function cmdInitRemote(opts: {
    aiballUrl?: string; aiballToken?: string; consumer?: string; project?: string;
}): void {
    if (!opts.aiballUrl) return; // only persist a remote when one is given
    if (!opts.aiballToken) {
        die("init: --aiball-token is required with --aiball-url (mint on the remote with `aiball auth issue --consumer <id>`)");
    }
    let p: string;
    try {
        p = writeLocalRemote(process.cwd(), {
            url: opts.aiballUrl,
            token: opts.aiballToken,
            consumer: opts.consumer,
            project: opts.project,
        });
    } catch (e) {
        die(`init: ${(e as Error).message}`);
    }
    process.stdout.write([
        `Wrote remote config → ${p} (chmod 600 — do NOT commit, it carries a token)`,
        ``,
        `  remote:`,
        `    url: ${opts.aiballUrl}`,
        `    token: ${opts.aiballToken.slice(0, 12)}…`,
        ...(opts.consumer ? [`    consumer: ${opts.consumer}`] : []),
        ...(opts.project ? [`    project: ${opts.project}`] : []),
        ``,
        `Now \`claude-loop start\` (no flags) in this dir slaves to the remote.`,
        `Per-start flags still override. (.aiball.local.yaml is git-ignored.)`,
        ``,
    ].join("\n"));
}

function buildStartCommand(invoke: (opts: StartOpts) => void): Command {
    return new Command()
        .description("Spawn a new claude-loop (default subcommand)")
        // #269 zcxndk: accept the name positionally too — david typed
        // `claude-loop start test-pty` and hit "too many arguments". The
        // `--name` option still works and takes precedence when both given.
        .argument("[name]", "Loop name — positional alias for --name (e.g. `claude-loop start test-pty`)")
        .option("--name <name>", "Loop name (default: auto-generated)")
        .addOption(new Option(
            "--interval <sec>",
            "Tick interval seconds (default from .aiball.yaml `claude_loop.interval_seconds`, 30 if unset — #B.180)",
        ))
        .option(
            "--check-cmd <cmd>",
            "Shell snippet — exit 0 = wake claude, non-zero = stay idle. " +
                "Default: empty = use the in-process AiballClient.pingsCount() (SSE-aware, fastpath). " +
                "Pass `true` to ping unconditionally every tick.",
            DEFAULT_CHECK_CMD,
        )
        .option("--pings <yaml>", "Path to custom ping-phrases YAML")
        // Commander convention: `--no-foo` flips foo to false.
        .option("--no-attach", "Don't attach after spawn (wrapper exits silently)")
        .option("--no-startup-ping", "Don't send a wake-up message on launch")
        .option("--no-resume", "#616: don't auto-inject `--resume` even when `.aiball.yaml claude.always_resume: true` says to. Per-invocation opt-out. Equivalent to `claude-loop start -- --no-resume`.")
        // #639 (david `uqdava`): explicit `--resume` flag forces BOTH
        // `claude.always_resume` AND `claude_loop.auto_resume` to true,
        // regardless of what the per-project .aiball.yaml says.
        .option("--resume", "#639: force resume mode for this invocation — overrides both `claude.always_resume` and `claude_loop.auto_resume` to true, regardless of yaml config. Mirror of `--no-resume` for the positive case.")
        .option("--force", "Spawn even if another live loop already runs in this cwd")
        .addOption(new Option(
            "--resume-mode <mode>",
            "How to auto-dismiss the claude --resume picker (summary | as-is | abort)",
        ).default("as-is").choices(["summary", "as-is", "abort"]))
        // #302/#343: --no-wait is now the DEFAULT (the loop is autonomous
        // far more often than human-driven). `--wait` (defined first so it
        // owns the falsy default) opts back into the boot-grace; `--no-wait`
        // stays accepted as the explicit/back-compat form.
        .option("--wait", "Wait out the boot-grace for a possible human take-over before draining pre-existing pings at boot (#302). Opt-in — the default is --no-wait.")
        .option("--no-wait", "(default since #343) Assume no human at the terminal: eager boot drain, no boot-grace deferral.")
        // #390: remote-daemon mode — run the loop locally but slave it to an
        // aiball daemon on another host (tailscale/LAN), no local aiball needed.
        .option("--aiball-url <url>", "#390: target a REMOTE aiball daemon over HTTP (http[s]://host:port) instead of the local socket. The loop, tmux pane and state stay local; only the data-plane is remote.")
        .option("--aiball-token <token>", "#390: bearer token for the remote daemon (mint with `aiball auth issue --consumer <id>` on the daemon host). Required with --aiball-url.")
        .option("--consumer <id>", "#390: consumer id = the loop's identity (overrides .aiball.yaml). Recommended with --aiball-url.")
        .option("--agent <id>", "#420: alias for --consumer (the loop's agent identity). Set a distinct one to run several loops in the same dir.")
        .option("--project <name>", "#390: project name (overrides .aiball.yaml).")
        // #393: launch in an explicit dir (e.g. the daemon spawning a loop for a
        // known project root from the UI) instead of the invoker's cwd.
        .option("--cwd <path>", "#393: launch the loop in this directory instead of the current one.")
        // #557 : `claude-loop --init` = bootstrap (.mcp.json + .aiball.yaml,
        // + remote persist si --aiball-url) PUIS start, en un coup. Idempotent
        // (skip si fichiers déjà là, sauf --init-force).
        .option("--init", "#557: run `claude-loop init` first (bootstrap project + persist remote if --aiball-url given), then start.")
        .option("--init-force", "#557: with --init, pass --force to bootstrap (overwrite existing entries).")
        .option("--init-stop-hook", "#557: with --init, also wire Claude Code's Stop hook into .claude/settings.json.")
        .option("--init-global", "#557: with --init --init-stop-hook, write to ~/.claude/settings.json instead of project-local.")
        .option("--init-private", "#593: with --init, seed .aiball.yaml with `project_type: private` (welcome serves the private kit)")
        // #636: pytest harness mode — the timer exits after one heartbeat cycle.
        .option("--once", "#636: pytest harness flag — exit the timer after one full heartbeat cycle (boot probe + tick + wake check). claude + tmux stay alive ; the caller orchestrates cleanup. Use with `claude-loop inspect` to snapshot state.")
        // #749 david — start with the wake kill-switch ON. Touches the
        // state-dir's `zen` marker right after creation, so the very first
        // tryWake (boot drain) is already muted. Toggle live afterwards via
        // `claude-loop zen <name>`.
        .option("--zen", "#749: start with all wakes muted (touches the `zen` marker). Toggle live with `claude-loop zen <name>`.")
        .allowExcessArguments(false)
        .action((nameArg: string | undefined, opts: {
            name?: string; interval?: string; checkCmd: string; pings?: string;
            attach: boolean; startupPing: boolean; force?: boolean;
            resumeMode?: string; wait: boolean; resume: boolean;
            aiballUrl?: string; aiballToken?: string; consumer?: string; agent?: string; project?: string;
            cwd?: string;
            init?: boolean; initForce?: boolean; initStopHook?: boolean; initGlobal?: boolean;
            once?: boolean; zen?: boolean;
        }, command: Command) => {
            // #305 (option a): only forward `wait` when --wait/--no-wait was
            // ACTUALLY passed. Otherwise leave it undefined so cmdStart falls
            // back to the per-project `.aiball.yaml claude_loop.wait` default.
            const waitExplicit = command.getOptionValueSource?.("wait") === "cli";
            invoke({
                name: opts.name ?? nameArg,
                interval: opts.interval !== undefined ? Math.max(1, Number(opts.interval)) : null,
                checkCmd: opts.checkCmd,
                pings: opts.pings,
                attach: opts.attach !== false,
                noStartupPing: opts.startupPing === false,
                runOnce: opts.once === true,
                force: opts.force === true,
                resumeMode: opts.resumeMode,
                wait: waitExplicit ? opts.wait : undefined,
                aiballUrl: opts.aiballUrl,
                aiballToken: opts.aiballToken,
                consumer: opts.consumer ?? opts.agent, // #420: --agent is an alias for --consumer
                project: opts.project,
                cwd: opts.cwd,
                init: opts.init === true,
                initForce: opts.initForce === true,
                initStopHook: opts.initStopHook === true,
                initGlobal: opts.initGlobal === true,
                // #616 — commander's `--no-resume` defaults opts.resume to
                // true ; only consider it "passed" when explicitly false.
                // #639 (david `uqdava`) — `--resume` explicitly true → force.
                noResume: opts.resume === false,
                forceResume: opts.resume === true && command.getOptionValueSource?.("resume") === "cli",
                zen: opts.zen === true,
                claudeArgs: [], // filled in by the dispatcher below
            });
        });
}

async function main(): Promise<void> {
    const { wrapper, passthrough } = splitClaudeArgs(process.argv.slice(2));
    // `claude-loop --tail [flags]` is a top-level alias for the
    // `tail` subcommand on the current-cwd loop. David: "claude-loop
    // --tail pourrait etre bien". Rewrite the args before dispatch
    // so commander parses it like an explicit `tail` invocation.
    // The log-mode flags (--log / --timer / --stop-hook) are also
    // accepted bare — they're tail sub-modes, and david typed
    // `claude-loop --log` directly expecting it to "just work".
    if (wrapper[0] === "--tail") wrapper[0] = "tail";
    else if (wrapper[0] === "--log" || wrapper[0] === "--timer" || wrapper[0] === "--stop-hook") {
        wrapper.unshift("tail");
    }
    // Bare top-level alias for `reload` (parity with `--tail`):
    // `claude-loop --reload` respawns the timer of the current-cwd
    // loop without touching claude.
    else if (wrapper[0] === "--reload") wrapper[0] = "reload";
    // #381 (david): bare top-level alias for the proxy-tty debug session.
    else if (wrapper[0] === "--debug-proxy-tty") wrapper[0] = "debug-proxy-tty";
    // #381 (david yf8wht): bare alias for the direct key-grammar reader.
    else if (wrapper[0] === "--debug-keys") wrapper[0] = "debug-keys";
    // Recognize lifecycle subcommands; everything else falls into start.
    const sub = wrapper[0];
    const known = new Set(["start", "list", "attach", "tail", "rm", "wake", "zen", "reload", "restart", "stop", "check", "status", "trace", "prune", "init", "inspect", "debug-proxy-tty", "debug-keys", "-h", "--help", "help"]);
    if (sub && !known.has(sub) && !sub.startsWith("--") && !sub.startsWith("-")) {
        die(`unknown subcommand: ${sub} (try --help)`);
    }

    const program = new Command()
        .name("claude-loop")
        .description("Wrap a Claude Code session in a tmux loop that wakes itself when idle (#B.63)")
        .version(AIBALL_VERSION, "-v, --version", "print the aiball version and exit")
        .helpOption("-h, --help", "Show help");
    program.addCommand(buildStartCommand((opts) => cmdStart({ ...opts, claudeArgs: passthrough })).name("start"));
    program.command("list").description("List all known loops").action(cmdList);
    program.command("attach [name]")
        .description("tmux attach to a loop session. Name optional — defaults to the single loop registered for the current cwd (#415).")
        .action((name: string | undefined) => cmdAttach(name));
    program.command("tail [name]")
        .description("Follow the claude pane live (--timer / --stop-hook / --log for the wake-decision logs). Name optional — defaults to the loop registered for the current cwd. Ctrl-C to stop; pass --once for a snapshot.")
        .option("--lines <n>", "Lines to show", "40")
        .option("--timer", "Follow the detached timer log instead of the claude pane")
        .option("--stop-hook", "Follow the Stop hook log (per-fire wake decisions + coalesce)")
        .option("--log", "Follow timer + stop-hook logs interleaved with [timer]/[hook] prefixes")
        .option("--once", "Snapshot only — print and exit instead of following")
        .action(async (name: string | undefined, opts: { lines: string; timer?: boolean; stopHook?: boolean; log?: boolean; once?: boolean }) => {
            const flags = [opts.timer, opts.stopHook, opts.log].filter(Boolean).length;
            if (flags > 1) die("pass only one of --timer / --stop-hook / --log");
            const which: TailMode = opts.timer ? "timer" : opts.stopHook ? "stop-hook" : opts.log ? "log" : "pane";
            const resolved = name ?? resolveCurrentLoopName();
            await cmdTail(resolved, Number(opts.lines), which, opts.once !== true);
        });
    program.command("rm [name]")
        .description("Kill tmux + timer + remove state dir. Name optional — defaults to the loop registered for the current cwd (mirrors reload/restart/stop).")
        .option("--force", "Silence error when state dir is missing")
        .action((name: string | undefined, opts: { force?: boolean }) => cmdRm(name ?? resolveCurrentLoopName(), opts.force === true));
    program.command("wake <name>")
        .description("Force the next timer tick to fire immediately")
        .action(cmdWake);
    // #749 david — `claude-loop zen <name>` kill-switch for all wakes.
    program.command("zen [name]")
        .description("Toggle the wake kill-switch for a loop. Touches a `zen` marker file the timer reads at the top of every `tryWake` ; mutes ALL injections (including afk-cleared-drain). Live — no reload needed. Bare = toggle ; `--on` / `--off` = explicit. Name optional — defaults to the current-cwd loop.")
        .option("--on", "force mute ON")
        .option("--off", "force mute OFF")
        .action((name: string | undefined, opts: { on?: boolean; off?: boolean }) => cmdZen(name ?? resolveCurrentLoopName(), opts));
    program.command("reload [name]")
        .description("Respawn the detached timer process without killing claude (picks up edited timer.ts / state.ts since tsx doesn't hot-reload). Also the SIGUSR2 action: `kill -USR2 <timer.pid>` reloads (#407 — unified with the daemon: HUP=restart, USR2=reload). Name optional — defaults to the loop registered for the current cwd.")
        .option("--set <kv...>", "#684: patch <state_dir>/env with KEY=VAL before the respawn. Repeatable (`--set A=1 --set B=2`). VAL='' drops the export (= unset). Typical use : flip a debug log opt-in (e.g. CL_PANE_CAPTURE_LOG=1) without editing the file by hand.")
        .action((name: string | undefined, opts: { set?: string[] }) => cmdReload(name ?? resolveCurrentLoopName(), opts));
    program.command("restart [name]")
        .description("HARD restart (#388): kill claude + the loop entirely, then relaunch fresh with the same start config (from the plate). Unlike `reload` (timer-only), this stops + starts. Detached + no-attach — reconnect with `attach`. Also the SIGHUP action: `kill -HUP <timer.pid>` self-restarts. Name optional — defaults to the current-cwd loop.")
        .action((name: string | undefined) => cmdRestart(name ?? resolveCurrentLoopName()));
    program.command("stop [name]")
        .description("Clean-STOP a loop: kill claude/tmux + exit the timer, but KEEP the state dir (loop shows dead, stays restart/prune-able — `rm` is the halt+delete). Also the SIGTERM action: `kill -TERM <timer.pid>` (#442 — convention HUP=restart, USR2=reload, TERM=stop). Remotely via the daemon: the Consumers-page stop button. Name optional — defaults to the current-cwd loop.")
        .action((name: string | undefined) => cmdStop(name ?? resolveCurrentLoopName()));
    program.command("check [name]")
        .description("Diagnose what the check-cmd would do right now (no claude spawn)")
        .option("--check-cmd <cmd>", "Override the check-cmd (default: from loop plate or DEFAULT_CHECK_CMD)")
        .option("--config", "Also inspect the loop's state dir + .aiball.yaml in its cwd (autopoll wiring)")
        .action((name: string | undefined, opts: { checkCmd?: string; config?: boolean }) => cmdCheck(name, opts));
    program.command("status [name]")
        .description("Show this project's connection status: resolved project + default agent (and their sources), the loaded .aiball.yaml, the connection type the aiball client would use (local Unix socket vs remote HTTP, token or not), and a live daemon reachability probe. Name optional — annotates the loop registered for the current cwd.")
        .action((name: string | undefined) => cmdStatus(name));
    program.command("trace")
        .description("Foreground gate evaluator — print WAKE/sleep every tick (no claude, no tmux)")
        .option("--check-cmd <cmd>", "Override the check-cmd (default: DEFAULT_CHECK_CMD)")
        .option("--interval <sec>", "Seconds between ticks (default: 10)")
        .option("--once", "Print one evaluation and exit")
        .option("--events", "Open SSE and tail every aiball event live (no gate eval)")
        .action((opts: { checkCmd?: string; interval?: string; once?: boolean; events?: boolean }) => cmdTrace(opts));
    program.command("prune").description("Interactively clean orphan state dirs").action(cmdPrune);
    program.command("inspect [name]")
        .description("#613 — JSON dump of a loop's full state (view + markers + runtime). Pure read, no side-effects. Pytest harnesses spawn the loop, wait a tick, then `inspect` to assert behaviour. Exits 1 if the state dir doesn't exist. Name optional — defaults to the current-cwd loop.")
        .action((name: string | undefined) => cmdInspect(name ?? resolveCurrentLoopName()));
    // #381 (david): "--debug-proxy-tty pour piper des choses et avoir un faux claude
    // logger derriere". Real PTY proxy + fake-claude byte logger, attached to this
    // terminal — see/capture EXACTLY what your keyboard emits + the AFK decision.
    program.command("debug-proxy-tty")
        .description("Run the real PTY proxy in front of a fake-claude byte logger to capture/diagnose what your keyboard actually emits + AFK toggling (#381)")
        .action(() => cmdDebugProxyTty());
    // #381 (david yf8wht): direct raw-stdin key reader — no PTY/tmux/claude. Shows
    // each keystroke's bytes + afk grammar decode, to tell if GNOME ate alt+esc.
    program.command("debug-keys")
        .description("Read keys directly from this terminal and print them in afk_key grammar (alt+esc, ctrl+g, …) — diagnose whether the WM/terminal swallows your combo (#381)")
        .action(() => cmdDebugKeys());
    // #304 david: alias for `aiball init` — bootstrap a project (.mcp.json +
    // .aiball.yaml) without leaving the claude-loop workflow. Shares the body.
    // #394 volet A: with --aiball-url, ALSO persist a REMOTE aiball connection
    // to .aiball.local.yaml so a plain `claude-loop start` slaves to it.
    // #600 david `483um7` — shared option declarations live in
    // `src/cli/bootstrap-options.ts`. Each surface adds its own remote-
    // related flags on top (claude-loop only : --aiball-url/--aiball-token).
    const initCmd = applyBootstrapOptions(program.command("init")
        .description("Bootstrap this project (.mcp.json + .aiball.yaml). With --aiball-url, also persist a REMOTE aiball connection (#394) so `start` slaves to it."))
        .option("--aiball-url <url>", "#394: persist a REMOTE aiball URL (http[s]://host:port) so `start` (no flags) slaves to it")
        .option("--aiball-token <token>", "#394: bearer token for the remote (required with --aiball-url; mint with `aiball auth issue --consumer <id>`)")
        .action(async (opts: { force?: boolean; stopHook?: boolean; global?: boolean; private?: boolean; aiballUrl?: string; aiballToken?: string; consumer?: string; agent?: string; project?: string; claim?: boolean; migrateFrom?: string }) => {
            // #603 david `4dzxp2` : --agent est un alias de --consumer (#420 le faisait
            // déjà sur `start`, on harmonise sur `init`).
            const consumer = opts.consumer ?? opts.agent;
            // #612 — tri-state for --no-claim : commander's `--no-X` magic
            // sets opts.X=false when passed (defaults true otherwise). We
            // want undefined when NOT passed so the existing field in
            // .aiball.yaml is left untouched ("init respecte les param
            // déjà posés sauf si dans la ligne de flag"). Detect explicitly.
            const noClaim = process.argv.includes("--no-claim") ? true : undefined;
            // #394: persist the remote connection first (validates --aiball-token).
            cmdInitRemote({ ...opts, consumer });
            // #603 (4dzxp2) + #612 : forward consumer + project + no-claim to
            // bootstrapInit so they ALSO land in .aiball.yaml (avant : seul
            // .aiball.local.yaml recevait l'identité remote → la config locale
            // ignorait l'override).
            await bootstrapInit({ ...opts, consumer, noClaim, migrateFrom: opts.migrateFrom });
        });

    // #651 david `w9sk25` — also expose `claude-loop init skill --overwrite`
    // so a user who ran `claude-loop init` can refresh the skill with the
    // same tool. Mirrors `aiball init skill` exactly (same flags, same
    // bootstrap.ts installSkill underneath).
    initCmd
        .command("skill")
        .description("Install or refresh the aiball Claude Code skill into ~/.claude/skills/aiball/ (or <cwd>/.claude/skills/aiball/ with --project)")
        .option("--project", "Install into <cwd>/.claude/skills/ instead of ~/.claude/skills/")
        .option("--global", "Install into ~/.claude/skills/ (default)")
        .option("--target <path>", "Explicit destination directory (overrides --project / --global)")
        .option("--overwrite", "Overwrite an existing SKILL.md at the destination")
        .action((o: { project?: boolean; global?: boolean; target?: string; overwrite?: boolean }) => {
            installSkill({
                project: o.project === true,
                global: o.global === true,
                target: o.target,
                force: o.overwrite === true,
            });
        });

    // -h / --help at top level → root help, not start help.
    if (sub === "-h" || sub === "--help" || sub === "help") {
        program.outputHelp();
        return;
    }
    // Default subcommand: if first arg is missing or a flag (not a
    // known subcommand), prepend `start`.
    if (!sub || sub.startsWith("-")) {
        const startArgs = ["start", ...wrapper];
        await program.parseAsync([process.argv[0], process.argv[1], ...startArgs]);
        return;
    }
    await program.parseAsync([process.argv[0], process.argv[1], ...wrapper]);
}

main().catch((e) => {
    process.stderr.write(`claude-loop: ${(e as Error).message ?? String(e)}\n`);
    process.exit(1);
});
