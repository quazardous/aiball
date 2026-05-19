#!/usr/bin/env tsx
/**
 * aiball CLI — replaces the legacy bash bin/aiball entry. Uses commander
 * for dispatch and shares the same HTTP/spool semantics with the rest of
 * the codebase through {@link AiballClient}.
 *
 * Global flag --human / -H swaps the active consumer to $AIBALL_HUMAN
 * (default "human"), so a single CLI invocation can play either side.
 */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { AiballClient } from "./client.js";
import { registerSandboxCommands } from "./sandbox/cli.js";
import { registerAuthCommands } from "./cli/auth.js";
import { registerTicketCommands } from "./cli/ticket.js";
import { registerAdminCommands } from "./cli/admin.js";
import { registerAutopollCommands } from "./cli/autopoll.js";
import {
    URL,
    die,
    userCwd,
    jsonline,
    out,
    fmtWhoami,
    fmtStatus,
    fmtSubscribe,
    fmtSubsList,
    fmtUnread,
    buildClient,
    withProject,
    gOpts,
    resolveInstallRoot,
} from "./cli/_helpers.js";

// =====================================================================
// Program + global options
// =====================================================================

const program = new Command();
program
    .name("aiball")
    .description("CLI for the inter-agent BAL daemon")
    .option(
        "-H, --human",
        "Act as the human moderator (consumer_id and default --by become $AIBALL_HUMAN, default \"human\")",
    )
    .option(
        "-J, --json",
        "Machine-readable JSON output (default is human-readable text). Must be placed before the subcommand, e.g. `aiball --json status`.",
    );

// =====================================================================
// ticket subcommands → ./cli/ticket.ts (#B.213 phase 3.C).
// rule + project + feed-path → ./cli/admin.ts (#B.213 phase 3.D).
// autopoll subcommands → ./cli/autopoll.ts (#B.213 phase 3.E).
// =====================================================================
registerTicketCommands(program);
registerAdminCommands(program);
registerAutopollCommands(program);

// =====================================================================
// whoami / subscriptions / unread
// =====================================================================

program
    .command("whoami")
    .description("Print the consumer_id used here (identity only — for daemon health use `aiball status`, for full config audit use `aiball check`)")
    .action(async (_opts, cmd) => {
        const globalOpts = gOpts(cmd);
        const client = buildClient(globalOpts);
        const { loadConfig } = await import("./autopoll/config.js");
        const cfg = loadConfig(userCwd());
        let source: string;
        if (globalOpts.human) source = "--human flag ($AIBALL_HUMAN)";
        else if (process.env.AIBALL_AGENT) source = "$AIBALL_AGENT env";
        else if (cfg.consumer.agent_source === "aiball.yaml") source = ".aiball.yaml consumer.agent";
        else if (cfg.consumer.agent_source === "mcp.json") source = ".mcp.json env (DEPRECATED)";
        else source = "<basename(cwd)>-claude (default)";
        const payload = {
            consumer_id: client.agentId,
            cwd: userCwd(),
            source,
            human: globalOpts.human === true,
            default_project: client.defaultProject,
        };
        out(payload, globalOpts, fmtWhoami);
    });

program
    .command("subscribe <project>")
    .description("Subscribe the current consumer to a project")
    .option("--catchup", "Start with the project's existing backlog")
    .option("--role <role>", "owner|follower")
    .action(async (proj: string, opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = client.resolveProject(proj);
        let sub: unknown;
        try {
            sub = await client.subscribe(
                project,
                opts.catchup === true,
                opts.role as "owner" | "follower" | undefined,
            );
        } catch {
            sub = { warning: "daemon unreachable, subscription not registered" };
        }
        const fp = (await client.feedPath(project)) as { path: string };
        const payload = {
            consumer_id: client.agentId,
            project,
            feed_path: fp.path,
            subscription: sub,
            monitor_command: `tail -F -n 0 ${fp.path}`,
        };
        out(payload, gOpts(cmd), fmtSubscribe);
    });

program
    .command("unsubscribe <project>")
    .description("Unsubscribe the current consumer from a project")
    .action(async (proj: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = client.resolveProject(proj);
        await client.unsubscribe(project);
        out(
            { unsubscribed: true, consumer_id: client.agentId, project },
            gOpts(cmd),
            (v) => `unsubscribed ${v.consumer_id} from ${v.project}`,
        );
    });

program
    .command("subs")
    .description("List this consumer's subscriptions")
    .action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        out(await client.mySubs(), gOpts(cmd), fmtSubsList);
    });

program
    .command("unread")
    .description("Pull unseen messages for the current consumer")
    .option("--project <project>")
    .option("--limit <n>", "Max rows to return", "100")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = withProject(client, opts.project);
        out(await client.unread(project, Number(opts.limit)), gOpts(cmd), fmtUnread);
    });

program
    .command("pings-count")
    .description(
        "Print the count of unread pings for the current consumer. " +
        "Exits 0 when count > 0 (= there's something to drain), exit 1 " +
        "when count === 0. Useful as a shell check in pipelines like " +
        "claude-loop's default check-cmd (#B.63).",
    )
    .option("-q, --quiet", "Suppress stdout (just use the exit code)")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const r = (await client.pingsCount()) as { consumer_id: string; unread: number };
        const n = r.unread ?? 0;
        if (!opts.quiet) process.stdout.write(`${n}\n`);
        process.exit(n > 0 ? 0 : 1);
    });

program
    .command("mark-read")
    .description("Bulk mark project messages as seen")
    .requiredOption("--project <project>", "Project to ack")
    .option("--up-to <id>", "Mark seen up to (and including) this message id")
    .option("--all", "Mark all current messages as seen")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = client.resolveProject(opts.project);
        if (!opts.all && !opts.upTo) {
            die("mark-read: provide --up-to N or --all");
        }
        const res = await client.markReadProject({
            project,
            ...(opts.all ? { all: true } : {}),
            ...(opts.upTo ? { upToId: Number(opts.upTo) } : {}),
        });
        out(res, gOpts(cmd), (v) => {
            const r = v as { acked?: number; consumer_id?: string };
            const n = r.acked ?? 0;
            return `marked ${n} message${n === 1 ? "" : "s"} read in ${project}${r.consumer_id ? ` (as ${r.consumer_id})` : ""}`;
        });
    });

// =====================================================================
// status / drain
// =====================================================================

function aiballHome(): string {
    return (
        process.env.AIBALL_HOME ??
        join(process.env.HOME ?? "/tmp", ".local", "share", "aiball")
    );
}

program
    .command("status")
    .description("Daemon liveness + spool/DB sizes (use `aiball check` for full project config audit, `aiball whoami` for identity only)")
    .action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        let up = false;
        let daemonInfo: unknown = null;
        try {
            daemonInfo = await client.health();
            up = true;
        } catch {
            /* daemon down */
        }
        const home = aiballHome();
        const spoolDir = join(home, "spool");
        let spoolCount = 0;
        if (existsSync(spoolDir)) {
            spoolCount = readdirSync(spoolDir).filter((f) => f.endsWith(".json")).length;
        }
        const dbPath = join(home, "aiball.db");
        let dbSize = 0;
        if (existsSync(dbPath)) {
            try {
                dbSize = statSync(dbPath).size;
            } catch {
                /* ignore */
            }
        }
        const payload = {
            daemon_up: up,
            url: URL,
            paths: {
                home,
                db: dbPath,
                db_size: dbSize,
                outbox_dir: join(home, "outbox"),
                spool_dir: spoolDir,
            },
            spool_pending: spoolCount,
            daemon: daemonInfo,
        };
        out(payload, gOpts(cmd), fmtStatus);
    });

program
    .command("check")
    .description(
        "Project-level health check: .aiball.json, hook wiring, agent id resolution, daemon reachability.",
    )
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { json?: boolean }, cmd) => {
        const { loadConfig } = await import("./autopoll/config.js");
        const cfg = loadConfig(userCwd());
        const client = buildClient(gOpts(cmd));

        // Source tracking now lives in loadConfig (#B.154) — no need
        // to re-walk the chain here. Previously this block parsed the
        // YAML config as JSON (buggy: always returned null, so every
        // resolved agent showed "[from .mcp.json]" regardless).
        const agentSource = cfg.consumer.agent_source;
        const projectSource = cfg.consumer.project_source;

        // Stop hook wiring check.
        const settingsPath = join(homedir(), ".claude", "settings.json");
        let stopHookWired = false;
        let stopHookCommand: string | null = null;
        if (existsSync(settingsPath)) {
            try {
                const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
                    hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
                };
                for (const entry of s.hooks?.Stop ?? []) {
                    for (const h of entry.hooks ?? []) {
                        if (h.command && /aiball-autopoll-stop\.sh$/.test(h.command)) {
                            stopHookWired = true;
                            stopHookCommand = h.command;
                        }
                    }
                }
            } catch {
                /* ignore */
            }
        }

        // Daemon reachability.
        let daemonUp = false;
        try {
            await client.health();
            daemonUp = true;
        } catch {
            /* down */
        }

        // Resolved unread ping count for the agent (only if daemon up + agent known).
        let pings: number | null = null;
        if (daemonUp && cfg.consumer.agent) {
            try {
                const r = (await new AiballClient({ agentId: cfg.consumer.agent }).pingsCount()) as {
                    unread: number;
                };
                pings = r.unread;
            } catch {
                pings = null;
            }
        }

        const payload = {
            cwd: userCwd(),
            config: {
                path: cfg.configPath,
                found: !!cfg.configPath,
            },
            autopoll: {
                enabled: cfg.autopoll.enabled,
                volatile: cfg.autopoll.volatile,
                backlog: cfg.autopoll.backlog,
                throttle_seconds: cfg.autopoll.throttle_seconds,
                tone: cfg.autopoll.tone,
                include_recent_tickets: cfg.autopoll.include_recent_tickets,
                reason: cfg.configPath
                    ? cfg.autopoll.enabled
                        ? "enabled via .aiball.yaml"
                        : "explicitly disabled in .aiball.yaml"
                    : "no .aiball.yaml found — hook stays silent",
            },
            consumer: {
                agent: cfg.consumer.agent,
                agent_source: agentSource,
                project: cfg.consumer.project,
                project_source: projectSource,
            },
            stop_hook: {
                wired: stopHookWired,
                command: stopHookCommand,
                settings_path: settingsPath,
            },
            daemon: {
                up: daemonUp,
                unread_pings: pings,
            },
            // #B.154: deprecation surface — `.mcp.json` env block is
            // the legacy identity-injection mechanism; users should
            // migrate to `.aiball.yaml consumer:*`. Independent of
            // whether the resolved value actually came from that
            // path (presence-in-file is what we flag).
            deprecation: {
                mcp_json_env_block: cfg.mcp_json_deprecated,
            },
        };

        // Honor either local `--json` (legacy) or the global `--json`.
        if (opts.json || gOpts(cmd).json) {
            jsonline(payload);
            return;
        }

        // Human-readable.
        const ok = (b: boolean): string => (b ? "✓" : "·");
        process.stdout.write(`aiball check — cwd: ${payload.cwd}\n\n`);
        process.stdout.write(`config\n`);
        process.stdout.write(`  ${ok(payload.config.found)} .aiball.yaml: ${payload.config.path ?? "(none found by walking up)"}\n`);
        process.stdout.write(`  ${ok(payload.autopoll.enabled)} autopoll: ${payload.autopoll.reason}\n`);
        if (payload.autopoll.enabled) {
            const mode = payload.autopoll.volatile ? "volatile (one-shot)" : "persistent";
            const backlog = payload.autopoll.backlog ? "backlog-trigger" : "pings-only";
            process.stdout.write(`     mode=${mode}, ${backlog}, throttle=${payload.autopoll.throttle_seconds}s, tone=${payload.autopoll.tone}, recent=${payload.autopoll.include_recent_tickets}\n`);
        } else if (!payload.config.found) {
            // #B.154 david: when the Stop hook is wired but no
            // .aiball.yaml exists, the project is half-set-up.
            // Surface the activation command so the user doesn't
            // have to dig into docs.
            process.stdout.write(`     activate with: aiball autopoll init\n`);
        }
        process.stdout.write(`\nconsumer\n`);
        process.stdout.write(`  ${ok(!!payload.consumer.agent)} agent:   ${payload.consumer.agent ?? "(unresolved)"} ${payload.consumer.agent_source ? `[from ${payload.consumer.agent_source}]` : ""}\n`);
        process.stdout.write(`  ${ok(!!payload.consumer.project)} project: ${payload.consumer.project ?? "(unresolved)"} ${payload.consumer.project_source ? `[from ${payload.consumer.project_source}]` : ""}\n`);
        process.stdout.write(`\nstop hook (~/.claude/settings.json)\n`);
        process.stdout.write(`  ${ok(payload.stop_hook.wired)} wired: ${payload.stop_hook.wired ? payload.stop_hook.command : "no aiball-autopoll-stop.sh entry"}\n`);
        if (!payload.stop_hook.wired) {
            process.stdout.write(`     enable with: ${resolveInstallRoot()}/install.sh --stop-hook\n`);
        }
        process.stdout.write(`\ndaemon\n`);
        process.stdout.write(`  ${ok(payload.daemon.up)} reachable\n`);
        if (payload.daemon.up && payload.consumer.agent) {
            process.stdout.write(`  ${ok(payload.daemon.unread_pings === 0)} unread pings for ${payload.consumer.agent}: ${payload.daemon.unread_pings ?? "?"}\n`);
        }
        if (payload.deprecation.mcp_json_env_block) {
            process.stdout.write(
                `\ndeprecation\n` +
                `  ! .mcp.json carries an mcpServers.aiball.env block with AIBALL_AGENT/PROJECT.\n` +
                `    This injection mechanism is deprecated (#B.154). Migrate to .aiball.yaml:\n\n` +
                `        consumer:\n` +
                `          agent: ${payload.consumer.agent ?? "<your-agent-id>"}\n` +
                `          project: ${payload.consumer.project ?? "<your-project>"}\n\n` +
                `    Then drop the env block from .mcp.json. See .aiball.yaml.example.\n`,
            );
        }
        process.stdout.write(`\n`);
    });

program
    .command("drain")
    .description("Touch the spool dir to nudge the daemon's spool watcher")
    .action(async (_opts, cmd) => {
        const home = aiballHome();
        const spoolDir = join(home, "spool");
        if (existsSync(spoolDir)) {
            const marker = join(spoolDir, ".drain-trigger");
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fs = require("node:fs");
                fs.writeFileSync(marker, "");
                fs.unlinkSync(marker);
            } catch {
                /* daemon will pick up next watch tick */
            }
        }
        // Then print the same status payload, for symmetry with bash.
        await program.parseAsync(["node", "aiball", "status"]);
        void cmd;
    });

// =====================================================================
// auth subcommands (#B.94) — moved to ./cli/auth.ts (#B.213 phase 3.A).
// =====================================================================
registerAuthCommands(program);


// =====================================================================
// mcp + init subcommands — wire .mcp.json non-destructively (#B.175)
// =====================================================================

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
    .action(async (opts: { force?: boolean }) => {
        const force = opts.force === true;
        await mcpInitAction(force);
        // Inline minimal .aiball.yaml — don't pull the example
        // template here, that one is reference doc with 60+ lines
        // of comments. The bootstrap should be tight.
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
        process.stdout.write(`\n${await resolveIdentityHint()}\n`);
        process.stdout.write(`Run \`aiball check\` to verify everything resolves.\n`);
    });

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
        const { loadConfig } = await import("./autopoll/config.js");
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


// =====================================================================
// sandbox subcommands (delegated)
// =====================================================================

registerSandboxCommands(program);

// =====================================================================
// Run
// =====================================================================

program.parseAsync(process.argv).catch((e) => {
    die((e as Error).message);
});
