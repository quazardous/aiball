#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop CLI (#B.63 TS port). Generic terminal wrapper that
 * makes a Claude Code session tickable via tmux + a Stop hook + a
 * detached timer process that wakes claude when idle by sending a
 * random ping phrase every CL_INTERVAL seconds. Claude decides what
 * (if anything) to do based on its own context / MCP tools.
 *
 * Subcommands (start is default): `start | list | attach | tail | rm
 * | wake | reload | check | trace | prune`. Anything after `--` is
 * passed verbatim to the spawned `claude`.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { AiballClient } from "../client.js";
import { applyToProcessEnv, resolveProjectContext, warnIfDeprecated } from "./project-context.js";
import {
    DEFAULT_CHECK_CMD,
    isInternalCheckCmd,
    MUX_CMD,
    STATE_ROOT,
    defaultPingsPath,
    envPath,
    idleMarkerPath,
    pickPingPhrase,
    pingsPath,
    platePath,
    readPlate,
    setTmuxStatus,
    stateDirFor,
    timerLogPath,
    timerPidPath,
    tmuxName,
    wakeRequestedPath,
    writePlate,
    ensureDir,
    type Plate,
} from "./state.js";

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
    return spawnSync("command", ["-v", cmd], { shell: true }).status === 0;
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

function tmuxAlive(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    return r.status === 0;
}

function selfRoot(): string {
    // src/claude-loop/cli.ts → up 2 = repo root
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
}

function defaultName(): string {
    return `cl-${randomBytes(3).toString("hex")}`;
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
    /**
     * User-grace seconds. null = use the resolved
     * `.aiball.yaml claude_loop.user_grace_seconds` default (#B.180).
     */
    userGraceSec?: number | null;
    /** Bypass the live-loop conflict check (#B.154). */
    force?: boolean;
    /** Resume-picker auto-dismiss (#B.154): summary | as-is | abort. */
    resumeMode?: string;
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
        if (tmuxAlive(name)) continue;
        try { rmSync(stateDirFor(name), { recursive: true, force: true }); }
        catch { /* ignore */ }
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
    for (const name of readdirSync(STATE_ROOT)) {
        if (!tmuxAlive(name)) continue;
        let plate: Plate | null = null;
        try { plate = readPlate(stateDirFor(name)); } catch { /* skip */ }
        if (!plate) continue;
        if (plate.cwd !== cwd) continue;
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
function resolveCurrentLoopName(): string {
    const cwd = process.env.CLAUDE_LOOP_CWD ?? process.cwd();
    if (!existsSync(STATE_ROOT)) die(`no loops registered (state root ${STATE_ROOT} missing). Pass a name or start one first.`);
    const matches: { name: string; alive: boolean }[] = [];
    for (const name of readdirSync(STATE_ROOT)) {
        const sd = stateDirFor(name);
        if (!existsSync(platePath(sd))) continue;
        let plate: Plate | null = null;
        try { plate = readPlate(sd); } catch { continue; }
        if (plate.cwd !== cwd) continue;
        matches.push({ name, alive: tmuxAlive(name) });
    }
    if (matches.length === 0) die(`no claude-loop registered for cwd ${cwd}. Pass a name or run \`claude-loop list\`.`);
    if (matches.length === 1) return matches[0].name;
    const alive = matches.filter((m) => m.alive);
    if (alive.length === 1) return alive[0].name;
    const names = matches.map((m) => `${m.name}${m.alive ? "" : " (dead)"}`).join(", ");
    die(`multiple loops in cwd ${cwd}: ${names}. Pass a name explicitly.`);
}

function cmdStart(opts: StartOpts): void {
    const name = opts.name ?? defaultName();
    const sd = stateDirFor(name);
    if (existsSync(sd)) {
        die(`loop '${name}' already exists at ${sd}. Use 'rm ${name}' first or pick another --name.`);
    }
    need(MUX_CMD);

    // #B.154: ProjectContext resolves cwd + AIBALL_AGENT +
    // AIBALL_PROJECT from .mcp.json once, then writes them back to
    // process.env so the timer + hooks + claude spawn with the
    // right identity. Single source for every subcommand.
    const ctx = resolveProjectContext();
    applyToProcessEnv(ctx);
    warnIfDeprecated(ctx);
    const cwd = ctx.cwd;

    // #B.154: housekeeping before spawn. (1) prune dead state dirs
    // so the user's ~/.claude-loop/ doesn't accumulate orphans from
    // every test run; (2) refuse to spawn if another LIVE loop
    // already runs in the same cwd for the same agent — david saw
    // 14 dead loops accumulate from repeated rm-less restarts.
    pruneDeadStateDirs();
    if (!opts.force) {
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
    copyFileSync(pingsSrc, pingsPath(sd));

    // #B.180 david: resolve timeouts (CLI flag > .aiball.yaml > built-in
    // default). loadConfig defaults are 60/60/300/2000 — see config.ts.
    const interval = opts.interval ?? ctx.claude_loop.interval_seconds;
    const userGraceSec = opts.userGraceSec ?? ctx.claude_loop.user_grace_seconds;
    const bootGraceSec = ctx.claude_loop.boot_grace_seconds; // no CLI flag yet — yaml-only
    const wakeInFlightTtlMs = ctx.claude_loop.wake_in_flight_ttl_ms; // yaml-only

    const plate: Plate = {
        name,
        created_at: new Date().toISOString(),
        interval,
        check_cmd: opts.checkCmd,
        pings_path: pingsPath(sd),
        cwd,
        claude_args: opts.claudeArgs,
    };
    writePlate(sd, plate);

    // Env file sourced before spawning claude (the Stop hook + timer
    // both read CL_* vars).
    const envLines = [
        `export CL_NAME=${shQuote(name)}`,
        `export CL_STATE_DIR=${shQuote(sd)}`,
        `export CL_INTERVAL=${String(interval)}`,
        `export CL_CHECK_CMD=${shQuote(opts.checkCmd)}`,
        `export CL_PINGS=${shQuote(pingsPath(sd))}`,
        // Read by the SessionStart hook to decide whether to ping at
        // boot. Empty / unset = ping (per default). "1" = stay silent.
        `export CL_NO_STARTUP_PING=${shQuote(opts.noStartupPing ? "1" : "")}`,
        // Seconds the timer stays out of the way after the human
        // submits a prompt (UserPromptSubmit hook refreshes the
        // user-took-over marker). 0 disables the grace.
        `export CL_USER_GRACE_SEC=${shQuote(String(userGraceSec))}`,
        // #B.180: boot-grace + wake-in-flight TTL, yaml-only knobs.
        `export CL_BOOT_GRACE_SEC=${shQuote(String(bootGraceSec))}`,
        `export CL_WAKE_IN_FLIGHT_TTL_MS=${shQuote(String(wakeInFlightTtlMs))}`,
        // #B.154: resume picker auto-dismiss mode. Read by the
        // SessionStart hook when source=resume.
        `export CL_RESUME_MODE=${shQuote(opts.resumeMode ?? "as-is")}`,
        // #B.154: persist the resolved aiball identity (from ctx) so
        // every hook fire and the timer process see the SAME
        // consumer as the spawn-time .mcp.json resolution. Without
        // this, a hook spawned via a fresh shell could fall back to
        // a random uuid via AiballClient.
        ...(ctx.agent ? [`export AIBALL_AGENT=${shQuote(ctx.agent)}`] : []),
        ...(ctx.project ? [`export AIBALL_PROJECT=${shQuote(ctx.project)}`] : []),
        "",
    ];
    writeFileSync(envPath(sd), envLines.join("\n"));

    // Inline Claude Code settings JSON: register the Stop hook (which
    // execs the TS hook via tsx) for THIS session only — no
    // pollution of the user's ~/.claude/settings.json.
    const root = selfRoot();
    const stopHookCmd = `npx --no-install tsx ${shQuote(join(root, "src/claude-loop/stop-hook.ts"))}`;
    const sessionStartHookCmd = `npx --no-install tsx ${shQuote(join(root, "src/claude-loop/session-start-hook.ts"))}`;
    const userPromptSubmitHookCmd = `npx --no-install tsx ${shQuote(join(root, "src/claude-loop/user-prompt-submit-hook.ts"))}`;
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
        },
    };
    const settingsJson = JSON.stringify(settings);

    // claude passthrough args. Shell-escape per-arg so the inline
    // bash command keeps them intact.
    const passthrough = opts.claudeArgs.map(shQuote).join(" ");
    // CL_CLAUDE_CMD lets you swap the binary+flags (everything before
    // --settings) for debugging: see what the inner command receives
    // without claude repainting the screen. Useful values:
    //   bash -c 'echo "args: $*"; sleep 99' --
    //   bash -c 'cat <<< "$*"; read' --
    // Default = real claude. Read once at spawn time, baked into the
    // session's inner command (so a fresh `claude-loop start` picks
    // up the current env, but in-flight loops stay as-spawned).
    const claudeBin = process.env.CL_CLAUDE_CMD ?? "claude --permission-mode auto";
    // IMPORTANT: no `{ … }` brace groups here. psmux interprets a
    // command starting with `{` as a PowerShell script block and
    // base64-UTF16-encodes it for `powershell -EncodedCommand`, which
    // then reaches bash as a bogus option and dies with
    // "invalid option name". Keep the inner command a flat sequence
    // of `;`-separated statements so psmux passes it through verbatim.
    const innerCmd =
        `source ${shQuote(envPath(sd))}; ` +
        `exec ${claudeBin} --settings ${shQuote(settingsJson)}` +
        (passthrough ? ` ${passthrough}` : "");

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
    spawnSync(MUX_CMD, ["set-option", "-t", tname, "status-left-length", "60"], { stdio: "ignore" });
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
    setTmuxStatus(name, "boot");

    // Detached timer process. Inherits CL_* env via the env file
    // sourced in the child shell. nohup-like: ignore SIGHUP, detach.
    const logFd = openSync(timerLogPath(sd), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    const child = spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd))} && exec npx --no-install tsx ${shQuote(timerScript)}`,
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

function cmdList(): void {
    if (!existsSync(STATE_ROOT)) {
        process.stdout.write("(no loops)\n");
        return;
    }
    const entries = readdirSync(STATE_ROOT).sort();
    let found = 0;
    for (const name of entries) {
        const sd = stateDirFor(name);
        if (!existsSync(platePath(sd))) continue;
        let plate: Plate;
        try { plate = readPlate(sd); } catch { continue; }
        const alive = tmuxAlive(name) ? "alive" : "dead";
        const idle = existsSync(idleMarkerPath(sd))
            ? `idle since ${readFileSync(idleMarkerPath(sd), "utf8").trim()}`
            : "—";
        process.stdout.write(
            `${name.padEnd(24)}  ${alive.padEnd(5)}  ${plate.interval}s  ${idle}\n`,
        );
        process.stdout.write(`${"".padEnd(24)}  dir=${plate.cwd}\n`);
        found++;
    }
    if (found === 0) process.stdout.write("(no loops)\n");
}

function cmdAttach(name: string): void {
    if (!tmuxAlive(name)) die(`loop '${name}' not alive`);
    spawnSync(MUX_CMD, ["attach", "-t", tmuxName(name)], { stdio: "inherit" });
}

type TailMode = "pane" | "timer" | "stop-hook" | "log";

/**
 * Print lines that appeared in `now` but weren't in `prev` (#B.198
 * follow). The pane buffer scrolls, so we anchor by finding the
 * longest suffix of `prev` that matches a prefix of `now` — anything
 * past that anchor is new content. Empty `prev` → first poll, dump
 * everything. No overlap → content scrolled past faster than we
 * polled, dump everything (best-effort, missed lines stay lost).
 */
function paneDelta(prev: string, now: string): string {
    if (!prev) return now;
    if (prev === now) return "";
    const a = prev.split("\n");
    const b = now.split("\n");
    for (let k = Math.min(a.length, b.length); k > 0; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
            if (a[a.length - k + i] !== b[i]) { match = false; break; }
        }
        if (match) return b.slice(k).join("\n");
    }
    return now;
}

async function followPane(name: string, lines: number): Promise<void> {
    let prev = "";
    let printedInitial = false;
    // Best-effort cleanup on Ctrl-C — let the SIGINT propagate.
    process.on("SIGINT", () => process.exit(0));
    while (true) {
        if (!tmuxAlive(name)) die(`loop '${name}' no longer alive`);
        const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], {
            encoding: "utf8",
        }) as SpawnSyncReturns<string>;
        if (r.status !== 0) die(`capture-pane failed for ${tmuxName(name)}`);
        const buf = r.stdout ?? "";
        if (!printedInitial) {
            const all = buf.split("\n");
            process.stdout.write(all.slice(-lines).join("\n") + "\n");
            prev = buf;
            printedInitial = true;
        } else {
            const delta = paneDelta(prev, buf);
            if (delta) {
                process.stdout.write(delta + (delta.endsWith("\n") ? "" : "\n"));
                prev = buf;
            }
        }
        await new Promise((res) => setTimeout(res, 500));
    }
}

/**
 * GNU tail prints chatty status lines on stderr when a watched file
 * disappears (claude-loop restart deletes the session's state dir):
 * "became inaccessible" / "est devenu inaccessible", "cannot use
 * inotify" / "impossible d'utiliser inotify", "reverting to polling"
 * / "retour à l'interrogation active". Tail itself keeps working via
 * polling — these are warnings, not errors — but they clutter the
 * `claude-loop --log` view. #B.210. We drop the known noise and let
 * any other stderr (real errors) through.
 */
const TAIL_NOISE_RE =
    /became inaccessible|est devenu inaccessible|cannot use inotify|impossible d'utiliser inotify|reverting to polling|retour à l'interrogation active|le répertoire contenant le fichier|directory containing the watched file|tail: cannot open .* for reading: No such file or directory|tail: impossible d'ouvrir .* en lecture: Aucun fichier ou dossier de ce nom/i;

function pipeFilteredStderr(child: import("node:child_process").ChildProcess): void {
    if (!child.stderr) return;
    let carry = "";
    child.stderr.on("data", (chunk: Buffer) => {
        const text = carry + chunk.toString("utf8");
        const out = text.split("\n");
        carry = out.pop() ?? "";
        for (const l of out) {
            if (!l) continue;
            if (TAIL_NOISE_RE.test(l)) continue;
            process.stderr.write(`${l}\n`);
        }
    });
    child.stderr.on("end", () => {
        if (carry && !TAIL_NOISE_RE.test(carry)) process.stderr.write(`${carry}\n`);
    });
}

function followFile(path: string, lines: number, prefix?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("tail", ["-n", String(lines), "-F", path], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        pipeFilteredStderr(child);
        if (child.stdout) {
            let carry = "";
            child.stdout.on("data", (chunk: Buffer) => {
                const text = carry + chunk.toString("utf8");
                const lines = text.split("\n");
                carry = lines.pop() ?? "";
                for (const l of lines) process.stdout.write(`${prefix ?? ""}${l}\n`);
            });
            child.stdout.on("end", () => { if (carry) process.stdout.write(`${prefix ?? ""}${carry}\n`); });
        }
        child.on("error", reject);
        child.on("exit", (code) => code === 0 || code === null ? resolve() : reject(new Error(`tail exited ${code}`)));
        process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
    });
}

async function cmdTail(name: string, lines: number, which: TailMode, follow: boolean): Promise<void> {
    if (which === "timer" || which === "stop-hook") {
        const log = which === "timer"
            ? timerLogPath(stateDirFor(name))
            : join(stateDirFor(name), "stop-hook.log");
        const label = which === "timer" ? "timer log" : "stop-hook log";
        if (!existsSync(log)) {
            if (!follow) die(`no ${label} at ${log}`);
            // Follow mode: tail -F handles a not-yet-existent file
            // (waits for it to appear). Helpful when the Stop hook
            // hasn't fired yet — user can leave it running.
        }
        if (!follow) {
            const all = readFileSync(log, "utf8").split("\n");
            process.stdout.write(all.slice(-lines).join("\n") + "\n");
            return;
        }
        await followFile(log, lines, undefined);
        return;
    }
    if (which === "log") {
        const sd = stateDirFor(name);
        const timer = timerLogPath(sd);
        const hook = join(sd, "stop-hook.log");
        // Prefixes name the source explicitly (#B.198, david: "il
        // faut quand meme dire le nom du hook"). Order is now
        // `<timestamp> <tag> <rest>` (david: "ça serait plus pratique
        // cet ordre heure [type event]"): we pull any leading ISO
        // timestamp out of the body line and reinject it BEFORE the
        // tag, so all sources show one consistent time column.
        const TIMER_TAG = "[timer]    ";
        const HOOK_TAG  = "[stop-hook]";
        const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+/;
        function reformat(line: string, tag: string): string {
            const m = ISO_RE.exec(line);
            if (m) return `${m[1]} ${tag} ${line.slice(m[0].length)}`;
            // No leading timestamp (older/foreign lines) — synthesize
            // a placeholder so columns still line up.
            return `${" ".repeat(24)} ${tag} ${line}`;
        }
        if (!follow) {
            for (const [p, tag] of [[timer, TIMER_TAG], [hook, HOOK_TAG]] as const) {
                if (!existsSync(p)) continue;
                const all = readFileSync(p, "utf8").split("\n");
                for (const l of all.slice(-lines)) process.stdout.write(`${reformat(l, tag)}\n`);
            }
            return;
        }
        const runFollow = async (path: string, tag: string): Promise<void> => {
            return new Promise((resolveP, rejectP) => {
                const child = spawn("tail", ["-n", String(lines), "-F", path], {
                    stdio: ["ignore", "pipe", "pipe"],
                });
                pipeFilteredStderr(child);
                let carry = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    const text = carry + chunk.toString("utf8");
                    const out = text.split("\n");
                    carry = out.pop() ?? "";
                    for (const l of out) process.stdout.write(`${reformat(l, tag)}\n`);
                });
                child.stdout?.on("end", () => {
                    if (carry) process.stdout.write(`${reformat(carry, tag)}\n`);
                });
                child.on("error", rejectP);
                child.on("exit", (code) => code === 0 || code === null ? resolveP() : rejectP(new Error(`tail exited ${code}`)));
                process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
            });
        };
        await Promise.race([
            runFollow(timer, TIMER_TAG),
            runFollow(hook, HOOK_TAG),
        ]);
        return;
    }
    // pane mode
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use --timer / --stop-hook / --log to inspect logs instead)`);
    }
    if (!follow) {
        const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], {
            encoding: "utf8",
        }) as SpawnSyncReturns<string>;
        if (r.status !== 0) die(`capture-pane failed for ${tmuxName(name)}`);
        const all = (r.stdout ?? "").split("\n");
        process.stdout.write(all.slice(-lines).join("\n") + "\n");
        return;
    }
    await followPane(name, lines);
}

function cmdRm(name: string, force: boolean): void {
    const sd = stateDirFor(name);
    spawnSync(MUX_CMD, ["kill-session", "-t", tmuxName(name)], { stdio: "ignore" });
    if (existsSync(timerPidPath(sd))) {
        try {
            const pid = Number(readFileSync(timerPidPath(sd), "utf8").trim());
            if (Number.isFinite(pid) && pid > 0) process.kill(pid);
        } catch { /* already dead */ }
    }
    if (existsSync(sd)) {
        rmSync(sd, { recursive: true, force: true });
        process.stdout.write(`removed loop '${name}'\n`);
    } else if (!force) {
        die(`no state dir at ${sd} (use --force to silence)`);
    }
}

function cmdWake(name: string): void {
    if (!tmuxAlive(name)) die(`loop '${name}' not alive`);
    const sd = stateDirFor(name);
    // Don't clear idle-since: the timer's first check is
    // `if (!idle-since) continue` — wiping it would make the next
    // tick SKIP instead of fire (regression noted in concept review).
    // We only need wake-requested set; timer reads it as a check-cmd
    // bypass. If claude is mid-turn (no idle-since), wake is queued
    // until claude finishes and the Stop hook decides what to do.
    writeFileSync(wakeRequestedPath(sd), new Date().toISOString());
    const plate = (() => { try { return readPlate(sd); } catch { return null; } })();
    const interval = plate?.interval ?? 60;
    process.stdout.write(
        `wake requested for '${name}' (fires at next timer tick when claude is idle, up to ${interval}s)\n`,
    );
}

/**
 * Respawn just the detached timer process without touching claude.
 * Needed because `tsx` doesn't hot-reload (#B.198): when timer.ts or
 * state.ts changes, the running timer keeps the old code in memory
 * until restarted — but `rm + start` kills claude too, losing the
 * conversation. `reload` kills the recorded timer pid and re-execs a
 * fresh one using the same env file the loop was started with, so the
 * tmux session + claude pane stay intact.
 */
function cmdReload(name: string): void {
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use 'start' to spawn a fresh one)`);
    }
    const sd = stateDirFor(name);
    if (!existsSync(platePath(sd))) die(`no state dir at ${sd}`);
    if (!existsSync(envPath(sd))) die(`no env file at ${envPath(sd)} — loop is broken, use rm + start`);

    let oldPid: number | null = null;
    if (existsSync(timerPidPath(sd))) {
        const raw = Number(readFileSync(timerPidPath(sd), "utf8").trim());
        if (Number.isFinite(raw) && raw > 0) oldPid = raw;
    }
    if (oldPid !== null) {
        try { process.kill(oldPid); } catch { /* already dead */ }
    }

    const root = selfRoot();
    const logFd = openSync(timerLogPath(sd), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    const child = spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd))} && exec npx --no-install tsx ${shQuote(timerScript)}`,
    ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    writeFileSync(timerPidPath(sd), String(child.pid) + "\n");

    const killed = oldPid !== null ? ` (killed old pid ${oldPid})` : "";
    process.stdout.write(`timer for '${name}' respawned${killed} — new pid ${child.pid}\n`);
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
    const checkCmd = opts.checkCmd ?? plateCheckCmd ?? process.env.CL_CHECK_CMD ?? DEFAULT_CHECK_CMD;
    process.stdout.write(`claude-loop check\n`);
    process.stdout.write(`  loop name      : ${plateName ?? name ?? "(no loop)"}\n`);
    process.stdout.write(`  check-cmd      : ${checkCmd}\n`);
    process.stdout.write(`  AIBALL_AGENT   : ${ctx.agent} (from ${ctx.agent_source})\n`);
    process.stdout.write(`  AIBALL_PROJECT : ${ctx.project ?? "(unset)"}\n`);
    if (ctx.config_path) {
        process.stdout.write(`  .aiball.yaml   : ${ctx.config_path}\n`);
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
            for (const f of ["plate.json", "env", "pings.yaml", "idle-since", "wake-requested", "user-took-over", "timer.pid", "timer.log"]) {
                const p = join(sd, f);
                process.stdout.write(`    ${f.padEnd(18)}  ${existsSync(p) ? "✓" : "—"}\n`);
            }
            if (plate) {
                process.stdout.write(`\n  plate.json contents:\n`);
                process.stdout.write(`    interval     : ${plate.interval}s\n`);
                process.stdout.write(`    pings_path   : ${plate.pings_path}\n`);
                process.stdout.write(`    cwd          : ${plate.cwd}\n`);
                process.stdout.write(`    claude_args  : ${plate.claude_args.length === 0 ? "(none)" : plate.claude_args.join(" ")}\n`);
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
            const ping = await client.pingsCount() as { consumer_id: string; unread: number };
            const subs = await client.mySubs() as Array<{
                project?: string;
                role?: string;
                ticket_id?: number;
            }>;
            process.stdout.write(`  resolved consumer_id  : ${ping.consumer_id}\n`);
            process.stdout.write(`  unread pings (this consumer): ${ping.unread}\n`);
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
            const verdict = ping.unread > 0 ? "WAKE (work to drain)" : "SLEEP (nothing)";
            process.stdout.write(`  verdict: ${verdict}\n`);
            const hasProjectSub = ctx.project !== null && projectSubs.some((s) => s.project === ctx.project);
            if (ctx.project && !hasProjectSub) {
                process.stdout.write(`  hint   : AIBALL_PROJECT=${ctx.project} is set but consumer '${ping.consumer_id}' has NO subscription on that project — new tickets there won't generate pings. Fix: subscribe via MCP \`subscribe({project: "${ctx.project}", role: "owner"})\` while running AS this consumer.\n`);
            }
            if (projectSubs.length === 0) {
                process.stdout.write(`  hint   : consumer '${ping.consumer_id}' looks ephemeral (random fallback?). Set AIBALL_AGENT to a stable id and subscribe it to the projects you care about.\n`);
            }
            process.exit(ping.unread > 0 ? 0 : 1);
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

    const checkCmd = opts.checkCmd ?? process.env.CL_CHECK_CMD ?? DEFAULT_CHECK_CMD;
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
                const r = await aiballClient.pingsCount() as { consumer_id: string; unread: number };
                const verdict = r.unread > 0 ? "WAKE" : "sleep";
                process.stdout.write(`[${ts}] tick ${tick}: consumer=${r.consumer_id} unread=${r.unread} → ${verdict}\n`);
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

async function cmdPrune(): Promise<void> {
    if (!existsSync(STATE_ROOT)) {
        process.stdout.write("nothing to prune\n");
        return;
    }
    const orphans: string[] = [];
    for (const name of readdirSync(STATE_ROOT)) {
        if (!tmuxAlive(name)) orphans.push(name);
    }
    if (orphans.length === 0) {
        process.stdout.write("nothing to prune\n");
        return;
    }
    process.stdout.write(`orphan state dirs (no tmux): ${orphans.join(" ")}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("remove them? [y/N] ");
    rl.close();
    if (!/^[Yy]$/.test(ans.trim())) {
        process.stdout.write("aborted\n");
        return;
    }
    for (const n of orphans) {
        rmSync(stateDirFor(n), { recursive: true, force: true });
    }
    process.stdout.write(`pruned ${orphans.length} orphan(s)\n`);
}

// Commander wiring. `start` is the default — bare `claude-loop` (or
// `claude-loop --name foo -- --model opus`) runs start. Anything
// after `--` is captured as claude_args.
function splitClaudeArgs(argv: string[]): { wrapper: string[]; passthrough: string[] } {
    const idx = argv.indexOf("--");
    if (idx === -1) return { wrapper: argv, passthrough: [] };
    return { wrapper: argv.slice(0, idx), passthrough: argv.slice(idx + 1) };
}

function buildStartCommand(invoke: (opts: StartOpts) => void): Command {
    return new Command()
        .description("Spawn a new claude-loop (default subcommand)")
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
        .option("--force", "Spawn even if another live loop already runs in this cwd")
        .addOption(new Option(
            "--resume-mode <mode>",
            "How to auto-dismiss the claude --resume picker (summary | as-is | abort)",
        ).default("as-is").choices(["summary", "as-is", "abort"]))
        .addOption(new Option(
            "--user-grace <sec>",
            "Seconds to stay out of the way after the human submits a prompt (default from .aiball.yaml `claude_loop.user_grace_seconds`, 60 if unset — #B.180, recalibrated #B.185)",
        ))
        .allowExcessArguments(false)
        .action((opts: {
            name?: string; interval?: string; checkCmd: string; pings?: string;
            attach: boolean; startupPing: boolean; userGrace?: string; force?: boolean;
            resumeMode?: string;
        }) => {
            invoke({
                name: opts.name,
                interval: opts.interval !== undefined ? Math.max(1, Number(opts.interval)) : null,
                checkCmd: opts.checkCmd,
                pings: opts.pings,
                attach: opts.attach !== false,
                noStartupPing: opts.startupPing === false,
                userGraceSec: opts.userGrace !== undefined ? Math.max(0, Number(opts.userGrace)) : null,
                force: opts.force === true,
                resumeMode: opts.resumeMode,
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
    // Recognize lifecycle subcommands; everything else falls into start.
    const sub = wrapper[0];
    const known = new Set(["start", "list", "attach", "tail", "rm", "wake", "reload", "check", "trace", "prune", "-h", "--help", "help"]);
    if (sub && !known.has(sub) && !sub.startsWith("--") && !sub.startsWith("-")) {
        die(`unknown subcommand: ${sub} (try --help)`);
    }

    const program = new Command()
        .name("claude-loop")
        .description("Wrap a Claude Code session in a tmux loop that wakes itself when idle (#B.63)")
        .helpOption("-h, --help", "Show help");
    program.addCommand(buildStartCommand((opts) => cmdStart({ ...opts, claudeArgs: passthrough })).name("start"));
    program.command("list").description("List all known loops").action(cmdList);
    program.command("attach <name>").description("tmux attach to a loop session").action(cmdAttach);
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
    program.command("rm <name>")
        .description("Kill tmux + timer + remove state dir")
        .option("--force", "Silence error when state dir is missing")
        .action((name: string, opts: { force?: boolean }) => cmdRm(name, opts.force === true));
    program.command("wake <name>")
        .description("Force the next timer tick to fire immediately")
        .action(cmdWake);
    program.command("reload [name]")
        .description("Respawn the detached timer process without killing claude (picks up edited timer.ts / state.ts since tsx doesn't hot-reload). Name optional — defaults to the loop registered for the current cwd.")
        .action((name: string | undefined) => cmdReload(name ?? resolveCurrentLoopName()));
    program.command("check [name]")
        .description("Diagnose what the check-cmd would do right now (no claude spawn)")
        .option("--check-cmd <cmd>", "Override the check-cmd (default: from loop plate or DEFAULT_CHECK_CMD)")
        .option("--config", "Also inspect the loop's state dir + .aiball.yaml in its cwd (autopoll wiring)")
        .action((name: string | undefined, opts: { checkCmd?: string; config?: boolean }) => cmdCheck(name, opts));
    program.command("trace")
        .description("Foreground gate evaluator — print WAKE/sleep every tick (no claude, no tmux)")
        .option("--check-cmd <cmd>", "Override the check-cmd (default: DEFAULT_CHECK_CMD)")
        .option("--interval <sec>", "Seconds between ticks (default: 10)")
        .option("--once", "Print one evaluation and exit")
        .option("--events", "Open SSE and tail every aiball event live (no gate eval)")
        .action((opts: { checkCmd?: string; interval?: string; once?: boolean; events?: boolean }) => cmdTrace(opts));
    program.command("prune").description("Interactively clean orphan state dirs").action(cmdPrune);

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
