#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop CLI (#B.63 TS port). Generic terminal wrapper that
 * makes a Claude Code session tickable via tmux + a Stop hook + a
 * detached timer process that wakes claude when idle by sending a
 * random ping phrase every CL_INTERVAL seconds. Claude decides what
 * (if anything) to do based on its own context / MCP tools.
 *
 * Subcommands (start is default): `start | list | attach | tail | rm
 * | wake | prune`. Anything after `--` is passed verbatim to the
 * spawned `claude`.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
    chmodSync,
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
import {
    DEFAULT_CHECK_CMD,
    MUX_CMD,
    STATE_ROOT,
    defaultPingsPath,
    envPath,
    idleMarkerPath,
    pickPingPhrase,
    pingsPath,
    platePath,
    readPlate,
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
    const r = spawnSync("command", ["-v", cmd], { shell: true });
    if (r.status !== 0) die(`missing dependency: ${cmd}`);
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
    interval: number;
    checkCmd: string;
    pings?: string;
    attach?: boolean;
    noStartupPing?: boolean;
    claudeArgs: string[];
}

function cmdStart(opts: StartOpts): void {
    const name = opts.name ?? defaultName();
    const sd = stateDirFor(name);
    if (existsSync(sd)) {
        die(`loop '${name}' already exists at ${sd}. Use 'rm ${name}' first or pick another --name.`);
    }
    need(MUX_CMD);

    const cwd = process.env.CLAUDE_LOOP_CWD ?? process.cwd();
    const pingsSrc = opts.pings ?? defaultPingsPath();
    if (!existsSync(pingsSrc)) die(`pings file not found: ${pingsSrc}`);

    ensureDir(sd);
    copyFileSync(pingsSrc, pingsPath(sd));

    const plate: Plate = {
        name,
        created_at: new Date().toISOString(),
        interval: opts.interval,
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
        `export CL_INTERVAL=${String(opts.interval)}`,
        `export CL_CHECK_CMD=${shQuote(opts.checkCmd)}`,
        `export CL_PINGS=${shQuote(pingsPath(sd))}`,
        // Read by the SessionStart hook to decide whether to ping at
        // boot. Empty / unset = ping (per default). "1" = stay silent.
        `export CL_NO_STARTUP_PING=${shQuote(opts.noStartupPing ? "1" : "")}`,
        "",
    ];
    writeFileSync(envPath(sd), envLines.join("\n"));

    // Inline Claude Code settings JSON: register the Stop hook (which
    // execs the TS hook via tsx) for THIS session only — no
    // pollution of the user's ~/.claude/settings.json.
    const root = selfRoot();
    const stopHookCmd = `npx --no-install tsx ${shQuote(join(root, "src/claude-loop/stop-hook.ts"))}`;
    const sessionStartHookCmd = `npx --no-install tsx ${shQuote(join(root, "src/claude-loop/session-start-hook.ts"))}`;
    const settings = {
        hooks: {
            // SessionStart fires once when claude has finished booting
            // — replaces the fragile `sleep 3 && send-keys` race the
            // wrapper used (#B.63 follow-up: david saw bugs when
            // claude was still prompting for MCP trust etc).
            SessionStart: [{
                matcher: "startup",
                hooks: [{ type: "command", command: sessionStartHookCmd }],
            }],
            Stop: [{ hooks: [{ type: "command", command: stopHookCmd }] }],
        },
    };
    const settingsJson = JSON.stringify(settings);

    // claude passthrough args. Shell-escape per-arg so the inline
    // bash command keeps them intact.
    const passthrough = opts.claudeArgs.map(shQuote).join(" ");
    const innerCmd =
        `source ${shQuote(envPath(sd))}; ` +
        `exec claude --permission-mode auto --settings ${shQuote(settingsJson)}` +
        (passthrough ? ` ${passthrough}` : "");

    const tname = tmuxName(name);
    let r = spawnSync(MUX_CMD, [
        "new-session", "-d", "-s", tname, "-c", cwd, "bash", "-lc", innerCmd,
    ]);
    if (r.status !== 0) die("tmux new-session failed");

    // Status bar so a loop session is visually distinct (cyan).
    for (const [k, v] of [
        ["status-bg", "colour39"],
        ["status-fg", "colour15"],
        ["status-left", ` CLAUDE-LOOP · ${name} `],
        ["status-left-length", "60"],
    ] as const) {
        spawnSync(MUX_CMD, ["set-option", "-t", tname, k, v], { stdio: "ignore" });
    }

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
            `  interval: ${opts.interval}s`,
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

function cmdTail(name: string, lines: number, timer: boolean): void {
    if (timer) {
        const log = timerLogPath(stateDirFor(name));
        if (!existsSync(log)) die(`no timer log at ${log}`);
        const all = readFileSync(log, "utf8").split("\n");
        process.stdout.write(all.slice(-lines).join("\n") + "\n");
        return;
    }
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use --timer to inspect the timer log)`);
    }
    const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `${tmuxName(name)}.0`, "-p"], {
        encoding: "utf8",
    }) as SpawnSyncReturns<string>;
    if (r.status !== 0) die(`capture-pane failed for ${tmuxName(name)}`);
    const all = (r.stdout ?? "").split("\n");
    process.stdout.write(all.slice(-lines).join("\n") + "\n");
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
        .addOption(new Option("--interval <sec>", "Tick interval seconds").default("60"))
        .option(
            "--check-cmd <cmd>",
            "Shell snippet — exit 0 = wake claude, non-zero = stay idle. " +
                "Default: `aiball pings-count -q` (wake when there are unread pings). " +
                "Pass `true` to ping unconditionally every tick.",
            DEFAULT_CHECK_CMD,
        )
        .option("--pings <yaml>", "Path to custom ping-phrases YAML")
        // Commander convention: `--no-foo` flips foo to false.
        .option("--no-attach", "Don't attach after spawn (wrapper exits silently)")
        .option("--no-startup-ping", "Don't send a wake-up message on launch")
        .allowExcessArguments(false)
        .action((opts: {
            name?: string; interval: string; checkCmd: string; pings?: string;
            attach: boolean; startupPing: boolean;
        }) => {
            invoke({
                name: opts.name,
                interval: Math.max(1, Number(opts.interval)),
                checkCmd: opts.checkCmd,
                pings: opts.pings,
                attach: opts.attach !== false,
                noStartupPing: opts.startupPing === false,
                claudeArgs: [], // filled in by the dispatcher below
            });
        });
}

async function main(): Promise<void> {
    const { wrapper, passthrough } = splitClaudeArgs(process.argv.slice(2));
    // Recognize lifecycle subcommands; everything else falls into start.
    const sub = wrapper[0];
    const known = new Set(["start", "list", "attach", "tail", "rm", "wake", "prune", "-h", "--help", "help"]);
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
    program.command("tail <name>")
        .description("Tail the claude pane (or --timer for the timer log)")
        .option("--lines <n>", "Lines to show", "40")
        .option("--timer", "Tail the detached timer log instead of the claude pane")
        .action((name: string, opts: { lines: string; timer?: boolean }) => {
            cmdTail(name, Number(opts.lines), opts.timer === true);
        });
    program.command("rm <name>")
        .description("Kill tmux + timer + remove state dir")
        .option("--force", "Silence error when state dir is missing")
        .action((name: string, opts: { force?: boolean }) => cmdRm(name, opts.force === true));
    program.command("wake <name>")
        .description("Force the next timer tick to fire immediately")
        .action(cmdWake);
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
