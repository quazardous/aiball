/**
 * `aiball mcp` + top-level `aiball init` bootstrap commands (carved
 * out of cli.ts in #B.213 phase 3.F on 2026-05-19). Behavior-
 * preserving move.
 *
 * `mcpInitAction` is the shared body called by both `aiball mcp init`
 * and the combined `aiball init`. `resolveIdentityHint` prints the
 * post-bootstrap "Next:" line.
 *
 * Exposed entry point: `registerBootstrapCommands(program)`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
import { die, userCwd, resolveInstallRoot } from "./_helpers.js";

/**
 * Shared `mcp init` body so both `aiball mcp init` and the combined
 * `aiball init` can call it. Returns false when the entry already
 * exists and --force wasn't passed (caller decides if that's an error).
 */
async function mcpInitAction(force: boolean): Promise<void> {
    const path = join(userCwd(), ".mcp.json");
    type McpFile = { mcpServers?: Record<string, unknown> };
    let json: McpFile = { mcpServers: {} };
    let existed = false;
    if (existsSync(path)) {
        existed = true;
        try {
            json = JSON.parse(readFileSync(path, "utf8")) as McpFile;
        } catch {
            die(`${path} exists but is invalid JSON — fix it by hand, then re-run`);
        }
        if (!json.mcpServers || typeof json.mcpServers !== "object") {
            json.mcpServers = {};
        }
    }
    const servers = json.mcpServers as Record<string, unknown>;
    const had = "aiball" in servers;
    if (had && !force) {
        process.stdout.write(`${path}: aiball entry already present — re-run with --force to overwrite (drops legacy env block)\n`);
        return;
    }
    servers.aiball = { command: "aiball-mcp" };
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    if (!existed) {
        process.stdout.write(`created ${path} with the aiball MCP entry\n`);
    } else if (!had) {
        process.stdout.write(`${path}: added aiball MCP entry (other servers preserved)\n`);
    } else {
        process.stdout.write(`${path}: aiball entry rewritten to canonical form (legacy env block dropped if any)\n`);
    }
}

/**
 * Build the post-bootstrap "Next:" hint. Reads the resolved config so
 * the hint shows the *actual* identity that will be used, not a
 * generic `<basename(cwd)>-claude` template. #B.209: david set
 * `consumer.project: m2m` in his .aiball.yaml to avoid an uppercase
 * `M2M-claude` agent name, but the old hint still printed the
 * template, which read as "your override was ignored".
 */
async function resolveIdentityHint(): Promise<string> {
    try {
        const { loadConfig } = await import("../autopoll/config.js");
        const cfg = loadConfig(userCwd());
        const agent = cfg.consumer.agent;
        const project = cfg.consumer.project;
        const sourceTag = cfg.consumer.agent_source
            ? ` [from ${cfg.consumer.agent_source}]`
            : "";
        return [
            `Next: identity resolves to '${agent}'${sourceTag}.`,
            project
                ? `      default project: '${project}'.`
                : `      (no default project — set 'consumer.project' in .aiball.yaml or export AIBALL_PROJECT)`,
            `      Override via .aiball.yaml keys 'consumer.agent' and 'consumer.project' if needed.`,
        ].join("\n");
    } catch {
        return `Next: identity defaults to '${basename(userCwd())}-claude'. Override via .aiball.yaml keys 'consumer.agent' and 'consumer.project' if needed.`;
    }
}

/**
 * Shared body of `aiball init` (#B.175), reused verbatim by `claude-loop init`
 * (#304 — david: "alias de aiball init"). Writes .mcp.json + a minimal
 * .aiball.yaml, optionally wires the Stop hook, then prints the identity hint.
 */
export async function bootstrapInit(opts: { force?: boolean; stopHook?: boolean; global?: boolean }): Promise<void> {
    const force = opts.force === true;
    await mcpInitAction(force);
    // Inline minimal .aiball.yaml — the verbose annotated template lives at
    // .aiball.yaml.example; the bootstrap stays tight.
    const yamlPath = join(userCwd(), ".aiball.yaml");
    if (existsSync(yamlPath) && !force) {
        process.stdout.write(`${yamlPath}: already exists — re-run with --force to overwrite\n`);
    } else {
        const body =
            "# Bootstrapped by `aiball init`. See .aiball.yaml.example for the full annotated template.\n" +
            "autopoll:\n" +
            "  enabled: true\n";
        writeFileSync(yamlPath, body);
        process.stdout.write(`${existsSync(yamlPath) && force ? "overwrote" : "created"} ${yamlPath} (autopoll enabled)\n`);
    }
    if (opts.stopHook === true) {
        wireStopHook({ global: opts.global === true });
    }
    process.stdout.write(`\n${await resolveIdentityHint()}\n`);
    process.stdout.write(`Run \`aiball check\` to verify everything resolves.\n`);
}

export function registerBootstrapCommands(program: Command): void {
    const mcp = program
        .command("mcp")
        .description("Manage the aiball entry in this project's .mcp.json");

    mcp
        .command("init")
        .description("Add the aiball MCP server to .mcp.json at cwd (preserves any existing entries)")
        .option("--force", "Overwrite an existing aiball entry (drops any legacy env block — #B.154)")
        .action(async (opts: { force?: boolean }) => {
            await mcpInitAction(opts.force === true);
            process.stdout.write(`\n${await resolveIdentityHint()}\n`);
        });

    /**
     * Combined bootstrap: `.mcp.json` (MCP wiring) + `.aiball.yaml`
     * (autopoll-on, identity overrides optional). David's ask (#B.175
     * "tu parle aussi de aiball autopoll init ??"): one command for
     * the Quickstart, instead of having the user run two.
     *
     * `.aiball.yaml` body is intentionally minimal — just enough to
     * flip autopoll on. The verbose annotated template lives at
     * `.aiball.yaml.example` for users who want to tune knobs.
     */
    program
        .command("init")
        .description("Bootstrap a project: write .mcp.json + .aiball.yaml (combines `mcp init` + `autopoll init`)")
        .option("--force", "Overwrite existing entries (passes through to both subactions)")
        .option("--stop-hook", "Also wire Claude Code's Stop hook into .claude/settings.json so this project's autopoll triggers")
        .option("--global", "With --stop-hook, write to ~/.claude/settings.json instead of <PWD>/.claude/settings.json (fires in every Claude Code session)")
        .action(async (opts: { force?: boolean; stopHook?: boolean; global?: boolean }) => {
            await bootstrapInit(opts);
        });

    // `aiball stop-hook install [--global]` — standalone wiring command,
    // shared between `aiball init --stop-hook` and install.ps1 -StopHook.
    // Doesn't touch .mcp.json or .aiball.yaml — pure hook wiring. Suitable
    // for global installs where you don't want the project-local artifacts
    // to land in install.ps1's CWD.
    const stopHook = program.command("stop-hook").description("Manage the Claude Code Stop hook (autopoll trigger)");
    stopHook
        .command("install")
        .description("Wire skill/hooks/aiball-autopoll-stop into .claude/settings.json")
        .option("--global", "Write to ~/.claude/settings.json (every Claude Code session). Default: project-local <PWD>/.claude/settings.json")
        .action((opts: { global?: boolean }) => {
            wireStopHook({ global: opts.global === true });
        });
}

/**
 * Wire the Claude Code Stop hook into .claude/settings.json so
 * autopoll triggers on session end. Picks the right wrapper extension
 * for the platform (.cmd on Windows, .sh elsewhere). Idempotent —
 * skips if the same hook command is already present. Project-local
 * by default; --global writes to ~/.claude/settings.json instead.
 *
 * Cross-platform replacement for install.sh --stop-hook, so it works
 * the same on the Windows install path (where install.sh doesn't run).
 */
function wireStopHook(opts: { global: boolean }): void {
    const installRoot = resolveInstallRoot();
    const ext = process.platform === "win32" ? "cmd" : "sh";
    const hookTargetRaw = join(installRoot, "skill", "hooks", `aiball-autopoll-stop.${ext}`);
    if (!existsSync(hookTargetRaw)) {
        process.stdout.write(`stop-hook: target script missing at ${hookTargetRaw} — install layout is broken\n`);
        return;
    }
    // Claude Code runs the Stop hook command via bash (even on Windows
    // — Git Bash for the spawned shell). Bash treats backslashes as
    // escape characters, so a JSON-encoded Windows path with `\\…`
    // gets eaten to `CUsersdavid…`. Use forward slashes on Windows
    // instead: both cmd.exe and bash handle `C:/path/to/file.cmd`
    // correctly, and JSON encodes `/` as itself.
    const hookTarget = process.platform === "win32"
        ? hookTargetRaw.replace(/\\/g, "/")
        : hookTargetRaw;
    const settingsPath = opts.global
        ? join(homedir(), ".claude", "settings.json")
        : join(userCwd(), ".claude", "settings.json");
    const scopeLabel = opts.global ? `global (~/.claude/settings.json)` : `project (${settingsPath})`;

    // Ensure parent dir exists. Read existing JSON or seed with {}.
    mkdirSync(dirname(settingsPath), { recursive: true });
    interface HookEntry { type?: string; command?: string }
    interface HookGroup  { matcher?: string; hooks?: HookEntry[] }
    interface Settings   { hooks?: { Stop?: HookGroup[] } & Record<string, HookGroup[] | undefined> }
    let settings: Settings = {};
    if (existsSync(settingsPath)) {
        try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings; }
        catch { settings = {}; }
    }

    // Match by basename for idempotence — covers both backslash and
    // forward-slash versions of the same path (handles users who
    // previously wired via install.sh or by hand).
    const stopGroups = settings.hooks?.Stop ?? [];
    const alreadyWired = stopGroups.some((g) =>
        (g.hooks ?? []).some((h) =>
            typeof h.command === "string" &&
            /aiball-autopoll-stop\.(sh|cmd)$/.test(h.command),
        ),
    );
    if (alreadyWired) {
        process.stdout.write(`stop-hook: already wired in ${scopeLabel}\n`);
        return;
    }

    // Backup existing settings once per pass (skipped if already
    // backed up earlier — matches install.sh's `cp -n` behavior).
    if (existsSync(settingsPath)) {
        const bak = `${settingsPath}.aiball-bak`;
        if (!existsSync(bak)) writeFileSync(bak, readFileSync(settingsPath));
    }

    settings.hooks ??= {};
    settings.hooks.Stop ??= [];
    settings.hooks.Stop.push({ hooks: [{ type: "command", command: hookTarget }] });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    process.stdout.write(`stop-hook: wired ${hookTarget} -> ${scopeLabel}\n`);
}
