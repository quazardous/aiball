/**
 * Sandbox subcommand group (start, list, attach, tail, rm, prune).
 * Mounted under `aiball sandbox …` via {@link registerSandboxCommands}.
 *
 * State lives under $STATE_ROOT/<NAME>/ (default ~/.aiball-sandbox/<name>).
 * Each sandbox provisions a tmux session `sb-<name>` running
 * `claude --settings '<inline-JSON>'` so the SessionStart + Stop hooks
 * apply to that session only — never the user's other sessions.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Command, Option } from "commander";
import { AiballClient } from "../client.js";
import {
    STATE_ROOT,
    WORKTREE_ROOT,
    ensureDir,
    envPath,
    platePath,
    readPlate,
    stateDirFor,
    writePlate,
    type Plate,
} from "./state.js";

const MUX_CMD = process.env.MUX_CMD ?? "tmux";

function die(msg: string): never {
    process.stderr.write(`aiball sandbox: ${msg}\n`);
    process.exit(1);
}

function warn(msg: string): void {
    process.stderr.write(`aiball sandbox: ${msg}\n`);
}

function need(cmd: string): void {
    const r = spawnSync("command", ["-v", cmd], { shell: true });
    if (r.status !== 0) die(`missing dependency: ${cmd}`);
}

function randomShort(): string {
    return randomBytes(4).toString("hex").slice(0, 6);
}

function ensureName(name: string | undefined): string {
    return name && name.length > 0 ? name : randomShort();
}

/**
 * If `name` is given, return it. Otherwise, when exactly one sandbox
 * state dir exists, return that name. When zero or many, die with a
 * helpful message listing the candidates.
 */
function resolveSingleName(name: string | undefined): string {
    if (name && name.length > 0) return name;
    if (!existsSync(STATE_ROOT)) {
        die("no sandboxes exist (state root missing). Run 'aiball sandbox start' or 'plain' first.");
    }
    const candidates = readdirSync(STATE_ROOT).filter((n) =>
        existsSync(platePath(stateDirFor(n))),
    );
    if (candidates.length === 0) {
        die("no sandboxes exist. Run 'aiball sandbox start' or 'plain' first.");
    }
    if (candidates.length > 1) {
        die(
            `multiple sandboxes — pass NAME explicitly. Candidates: ${candidates.join(", ")}`,
        );
    }
    return candidates[0];
}

function installRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // <ROOT>/src/sandbox/ → up two = <ROOT>.
    return resolve(here, "..", "..");
}

function hookTemplate(name: string): string {
    return join(installRoot(), "skill", "hooks", name);
}

function tmuxHasSession(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", name], { stdio: "ignore" });
    return r.status === 0;
}

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Override the tmux status-bar so a sandbox session is visually
 * unmistakable. Loop sandboxes get orange; plain mux tests get blue.
 * No-op on screen (or any non-tmux MUX_CMD).
 */
function applySandboxStyle(tmuxName: string, mode: "loop" | "plain", name: string): void {
    if (MUX_CMD !== "tmux") return;
    const bg = mode === "loop" ? "colour208" : "colour33"; // orange / blue
    const label = mode === "loop" ? "SANDBOX" : "MUX-TEST";
    // status-right shows how to leave the session — tmux's default prefix
    // is C-b; users with a custom prefix will mentally translate.
    const right = ` C-b d detach │ \`aiball sandbox rm ${name}\` to kill `;
    const opts: [string, string][] = [
        ["status-bg", bg],
        ["status-fg", "colour15"],
        ["status-left", ` ${label} · ${name} `],
        ["status-left-length", "60"],
        ["status-right", right],
        ["status-right-length", String(right.length + 2)],
        ["window-status-current-style", `bg=${bg},fg=colour15,bold`],
        // Defensive: if the user has `remain-on-exit on` globally, force
        // it off here so claude exiting cleanly tears down the session.
        ["remain-on-exit", "off"],
    ];
    for (const [k, v] of opts) {
        spawnSync(MUX_CMD, ["set-option", "-t", tmuxName, k, v], { stdio: "ignore" });
    }
}

/**
 * Print a one-shot hint to stderr after the user detaches from (or after
 * claude exited inside) the tmux session, explaining their next options
 * based on whether the session is still alive.
 */
function postSessionHint(name: string): void {
    const tmuxName = `sb-${name}`;
    const sd = stateDirFor(name);
    if (tmuxHasSession(tmuxName)) {
        process.stderr.write(
            [
                "",
                `sandbox '${name}' still running in the background.`,
                `  re-attach: aiball sandbox attach ${name}`,
                `  peek:      aiball sandbox tail ${name}`,
                `  kill:      aiball sandbox rm ${name}`,
                "",
            ].join("\n"),
        );
        return;
    }
    if (existsSync(sd)) {
        process.stderr.write(
            [
                "",
                `sandbox '${name}' exited (tmux session gone).`,
                `  state remains at ${sd}`,
                `  clean up: aiball sandbox rm ${name}`,
                "",
            ].join("\n"),
        );
        return;
    }
    process.stderr.write(`\nsandbox '${name}' exited and cleaned up.\n`);
}

interface StartOpts {
    tickets: string;
    name?: string;
    worktree?: boolean;
    base?: string;
    attach?: boolean;
}

async function cmdStart(opts: StartOpts): Promise<void> {
    const ticketIds = opts.tickets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const n = Number(s);
            if (!Number.isFinite(n) || n <= 0) die(`invalid ticket id: ${s}`);
            return n;
        });
    if (ticketIds.length === 0) die("no valid ticket ids in --tickets");

    const name = ensureName(opts.name);
    const sd = stateDirFor(name);
    if (existsSync(sd)) {
        die(
            `sandbox '${name}' already running (state at ${sd}). ` +
                `Use 'rm ${name}' first or pick another --name.`,
        );
    }

    const agent = process.env.AIBALL_AGENT ?? `claude-${name}`;
    let project = process.env.AIBALL_PROJECT;
    if (!project) {
        const client = new AiballClient({ agentId: agent });
        try {
            const resp = (await client.getTicket(ticketIds[0])) as {
                ticket: { project?: string };
            };
            project = resp.ticket?.project;
        } catch {
            /* fall through */
        }
        if (!project) {
            die(
                `could not resolve project from #B.${ticketIds[0]} (set AIBALL_PROJECT).`,
            );
        }
    }

    let dir: string;
    if (opts.worktree) {
        need("git");
        dir = join(WORKTREE_ROOT, name);
        ensureDir(WORKTREE_ROOT);
        const baseRef = opts.base ?? "HEAD";
        const r = spawnSync(
            "git",
            ["worktree", "add", dir, "-b", `sandbox/${name}`, baseRef],
            { stdio: "inherit" },
        );
        if (r.status !== 0) die("git worktree add failed");
    } else {
        dir = process.cwd();
        if (opts.base) warn("--base is ignored without --worktree");
    }

    ensureDir(join(sd, "hooks"));
    copyFileSync(
        hookTemplate("sandbox-session-start.sh"),
        join(sd, "hooks", "session-start.sh"),
    );
    copyFileSync(hookTemplate("sandbox-stop.sh"), join(sd, "hooks", "stop.sh"));
    chmodSync(join(sd, "hooks", "session-start.sh"), 0o755);
    chmodSync(join(sd, "hooks", "stop.sh"), 0o755);

    const plate: Plate = {
        agent,
        name,
        mode: opts.worktree ? "worktree" : "in-place",
        dir,
        project,
        tickets: ticketIds.map((id) => ({ id, status: "open" })),
        halt: false,
    };
    writePlate(sd, plate);

    writeFileSync(
        envPath(sd),
        [
            `export AIBALL_URL="${process.env.AIBALL_URL ?? "http://127.0.0.1:7777"}"`,
            `export AIBALL_AGENT="${agent}"`,
            `export AIBALL_PROJECT="${project}"`,
            `export AIBALL_MCP_MODE="sandbox"`,
            `export SB_NAME="${name}"`,
            `export SB_STATE_DIR="${sd}"`,
            `export SB_INSTALL_ROOT="${installRoot()}"`,
            "",
        ].join("\n"),
    );

    const settings = {
        hooks: {
            SessionStart: [
                {
                    matcher: "startup",
                    hooks: [
                        {
                            type: "command",
                            command: join(sd, "hooks", "session-start.sh"),
                        },
                    ],
                },
            ],
            Stop: [
                {
                    hooks: [
                        {
                            type: "command",
                            command: join(sd, "hooks", "stop.sh"),
                        },
                    ],
                },
            ],
        },
    };
    const settingsJson = JSON.stringify(settings);

    need(MUX_CMD);
    const tmuxName = `sb-${name}`;
    const innerCmd = `source "${sd}/env"; exec claude --settings ${shQuote(settingsJson)}`;
    const r = spawnSync(MUX_CMD, [
        "new-session",
        "-d",
        "-s",
        tmuxName,
        "-c",
        dir,
        "bash",
        "-lc",
        innerCmd,
    ]);
    if (r.status !== 0) die("tmux new-session failed");
    applySandboxStyle(tmuxName, "loop", name);

    process.stdout.write(
        [
            `sandbox '${name}' started`,
            `  agent:   ${agent}`,
            `  project: ${project}`,
            `  mode:    ${plate.mode}`,
            `  dir:     ${dir}`,
            `  state:   ${sd}`,
            `  tickets: ${ticketIds.map((id) => `#B.${id}`).join(", ")}`,
            `  attach:  ${MUX_CMD} attach -t ${tmuxName}   (or: aiball sandbox attach ${name})`,
            "",
        ].join("\n"),
    );

    if (opts.attach) {
        spawnSync(MUX_CMD, ["attach", "-t", tmuxName], { stdio: "inherit" });
    }
}

function cmdList(): void {
    if (!existsSync(STATE_ROOT)) {
        process.stdout.write("(no sandboxes)\n");
        return;
    }
    const entries = readdirSync(STATE_ROOT);
    if (entries.length === 0) {
        process.stdout.write("(no sandboxes)\n");
        return;
    }
    let found = 0;
    for (const name of entries.sort()) {
        const sd = stateDirFor(name);
        const p = platePath(sd);
        if (!existsSync(p)) continue;
        let plate: Plate;
        try {
            plate = readPlate(sd);
        } catch {
            continue;
        }
        const tmuxName = `sb-${name}`;
        const alive = tmuxHasSession(tmuxName) ? "alive" : "dead";
        const groups: Record<string, number> = {};
        for (const t of plate.tickets) {
            groups[t.status] = (groups[t.status] ?? 0) + 1;
        }
        const summary = Object.entries(groups)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
        process.stdout.write(
            `${name.padEnd(30)}  ${alive.padEnd(5)}  ${plate.mode.padEnd(9)}  ${summary}\n`,
        );
        process.stdout.write(`${"".padEnd(30)}  dir=${plate.dir}\n`);
        if (plate.halt) process.stdout.write(`${"".padEnd(30)}  HALT=true\n`);
        found++;
    }
    if (found === 0) process.stdout.write("(no sandboxes)\n");
}

function cmdAttach(name: string, readOnly: boolean): void {
    if (!tmuxHasSession(`sb-${name}`)) {
        die(`sandbox '${name}' has no tmux session (already exited?)`);
    }
    const args = ["attach", "-t", `sb-${name}`];
    if (readOnly) args.push("-r");
    spawnSync(MUX_CMD, args, { stdio: "inherit" });
    postSessionHint(name);
}

function cmdTail(name: string, lines: number): void {
    const r = spawnSync(MUX_CMD, ["capture-pane", "-t", `sb-${name}`, "-p"], {
        encoding: "utf8",
    }) as SpawnSyncReturns<string>;
    if (r.status !== 0) die(`tmux capture-pane failed for sb-${name}`);
    const all = (r.stdout ?? "").split("\n");
    const slice = all.slice(Math.max(0, all.length - lines));
    process.stdout.write(slice.join("\n") + "\n");
}

function cmdRm(name: string, force: boolean): void {
    const sd = stateDirFor(name);
    const p = platePath(sd);

    if (existsSync(p) && !force) {
        try {
            const plate = readPlate(sd);
            const open = plate.tickets.filter((t) => t.status === "open").length;
            if (open > 0) {
                warn(
                    `sandbox '${name}' has ${open} open ticket(s) in plate. Pass --force to remove anyway.`,
                );
                process.exit(2);
            }
        } catch {
            /* skip warning if unreadable */
        }
    }

    spawnSync(MUX_CMD, ["kill-session", "-t", `sb-${name}`], { stdio: "ignore" });

    if (existsSync(p)) {
        try {
            const plate = readPlate(sd);
            if (plate.mode === "worktree" && plate.dir && existsSync(plate.dir)) {
                const args = ["worktree", "remove", plate.dir];
                if (force) args.push("--force");
                const r = spawnSync("git", args, { stdio: "inherit" });
                if (r.status !== 0) {
                    warn(`could not remove worktree ${plate.dir} (still alive?)`);
                }
            }
        } catch {
            /* skip */
        }
    }

    rmSync(sd, { recursive: true, force: true });
    process.stdout.write(`removed sandbox '${name}'\n`);
}

interface PlainOpts {
    name?: string;
    worktree?: boolean;
    base?: string;
    attach?: boolean;
}

/**
 * Bare wrapper-mux test: spawn a tmux session running plain `claude`,
 * with no hooks, no plate, no MCP hardening. Used to verify that the
 * multiplexing layer + install paths work before trusting the full
 * sandbox loop.
 */
function cmdPlain(opts: PlainOpts): void {
    const name = ensureName(opts.name);
    const sd = stateDirFor(name);
    if (existsSync(sd)) {
        die(
            `sandbox '${name}' already exists (state at ${sd}). ` +
                `Use 'rm ${name}' first or pick another --name.`,
        );
    }

    let dir: string;
    if (opts.worktree) {
        need("git");
        dir = join(WORKTREE_ROOT, name);
        ensureDir(WORKTREE_ROOT);
        const baseRef = opts.base ?? "HEAD";
        const r = spawnSync(
            "git",
            ["worktree", "add", dir, "-b", `sandbox/${name}`, baseRef],
            { stdio: "inherit" },
        );
        if (r.status !== 0) die("git worktree add failed");
    } else {
        dir = process.cwd();
        if (opts.base) warn("--base is ignored without --worktree");
    }

    // Minimal state so list/attach/tail/rm still work on the plain session.
    ensureDir(sd);
    const plate: Plate = {
        agent: process.env.AIBALL_AGENT ?? `claude-${name}`,
        name,
        mode: opts.worktree ? "worktree" : "in-place",
        dir,
        project: process.env.AIBALL_PROJECT ?? "(plain)",
        tickets: [],
        halt: false,
    };
    writePlate(sd, plate);
    writeFileSync(
        envPath(sd),
        [
            `# plain mux test session — no hooks, no MCP hardening`,
            `export SB_NAME="${name}"`,
            `export SB_STATE_DIR="${sd}"`,
            "",
        ].join("\n"),
    );

    need(MUX_CMD);
    const tmuxName = `sb-${name}`;
    const r = spawnSync(
        MUX_CMD,
        ["new-session", "-d", "-s", tmuxName, "-c", dir, "bash", "-lc", "exec claude"],
    );
    if (r.status !== 0) die("tmux new-session failed");
    applySandboxStyle(tmuxName, "plain", name);

    process.stdout.write(
        [
            `plain sandbox '${name}' started (no hooks, no plate)`,
            `  mode:   ${plate.mode}`,
            `  dir:    ${dir}`,
            `  state:  ${sd}`,
            `  attach: ${MUX_CMD} attach -t ${tmuxName}   (or: aiball sandbox attach ${name})`,
            "",
        ].join("\n"),
    );

    if (opts.attach) {
        spawnSync(MUX_CMD, ["attach", "-t", tmuxName], { stdio: "inherit" });
    }
}

async function cmdPrune(): Promise<void> {
    const orphanTmux: string[] = [];
    const orphanState: string[] = [];

    const ls = spawnSync(MUX_CMD, ["ls", "-F", "#S"], {
        encoding: "utf8",
    }) as SpawnSyncReturns<string>;
    const sessions = (ls.stdout ?? "")
        .split("\n")
        .filter((s) => s.startsWith("sb-"));
    for (const tn of sessions) {
        const name = tn.slice(3);
        if (!existsSync(stateDirFor(name))) orphanTmux.push(tn);
    }

    if (existsSync(STATE_ROOT)) {
        for (const name of readdirSync(STATE_ROOT)) {
            if (!tmuxHasSession(`sb-${name}`)) orphanState.push(name);
        }
    }

    if (orphanTmux.length === 0 && orphanState.length === 0) {
        process.stdout.write("nothing to prune\n");
        return;
    }
    if (orphanTmux.length) {
        process.stdout.write(
            `orphan tmux sessions (no state dir):\n  ${orphanTmux.join(" ")}\n`,
        );
    }
    if (orphanState.length) {
        process.stdout.write(`orphan state dirs (no tmux):\n  ${orphanState.join(" ")}\n`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("kill them all? [y/N] ");
    rl.close();
    if (!/^[Yy]$/.test(ans.trim())) {
        process.stdout.write("aborted\n");
        return;
    }
    for (const tn of orphanTmux) {
        spawnSync(MUX_CMD, ["kill-session", "-t", tn], { stdio: "ignore" });
    }
    for (const n of orphanState) {
        rmSync(stateDirFor(n), { recursive: true, force: true });
    }
    process.stdout.write("pruned\n");
}

export function registerSandboxCommands(program: Command): void {
    const sb = program
        .command("sandbox")
        .description("Provision autonomous Claude Code loops on aiball tickets");

    sb.command("start")
        .description("Spawn a new sandbox tmux session running claude on the listed tickets")
        .requiredOption("--tickets <ids>", "Comma-separated ticket ids (or repeat --ticket)")
        .option("--name <name>", "Sandbox name (default: auto-generated)")
        .option("--worktree", "Create a git worktree under ~/sandboxes/<name>")
        .option("--base <ref>", "Worktree base ref (default HEAD)")
        .option("--attach", "Attach to the tmux session after spawn")
        .action(async (opts: StartOpts) => {
            await cmdStart(opts);
        });

    sb.command("plain")
        .description("Spawn a tmux session running plain claude — for testing the mux layer (no hooks, no plate)")
        .option("--name <name>", "Sandbox name (default: auto-generated)")
        .option("--worktree", "Create a git worktree under ~/sandboxes/<name>")
        .option("--base <ref>", "Worktree base ref (default HEAD)")
        .option("--attach", "Attach to the tmux session after spawn")
        .action((opts: PlainOpts) => cmdPlain(opts));

    sb.command("list")
        .description("List all known sandboxes with their state summary")
        .action(() => cmdList());

    sb.command("attach [name]")
        .description("tmux attach to a sandbox session (NAME inferred when there's only one)")
        .option("-r, --read-only", "Read-only attach (keystrokes don't reach the session)")
        .action((name: string | undefined, opts: { readOnly?: boolean }) =>
            cmdAttach(resolveSingleName(name), opts.readOnly === true),
        );

    sb.command("tail [name]")
        .description("Print the last N lines of a sandbox pane (non-blocking; NAME inferred when only one)")
        .addOption(new Option("--lines <n>", "Lines to show").default("40"))
        .action((name: string | undefined, opts: { lines: string }) => {
            cmdTail(resolveSingleName(name), Number(opts.lines));
        });

    sb.command("rm [name]")
        .description("Kill the tmux session and remove the state dir (and worktree); NAME inferred when only one")
        .option("--force", "Force-remove even with open tickets / dirty worktree")
        .action((name: string | undefined, opts: { force?: boolean }) => {
            cmdRm(resolveSingleName(name), opts.force === true);
        });

    sb.command("prune")
        .description("Interactively clean orphan tmux sessions and state dirs")
        .action(async () => {
            await cmdPrune();
        });
}
