#!/usr/bin/env tsx
/**
 * aiball CLI — replaces the legacy bash bin/aiball entry. Uses commander
 * for dispatch and shares the same HTTP/spool semantics with the rest of
 * the codebase through {@link AiballClient}.
 *
 * Global flag --human / -H swaps the active consumer to $AIBALL_HUMAN
 * (default "human"), so a single CLI invocation can play either side.
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { AiballClient } from "./client.js";
import { AIBALL_VERSION } from "./version.js";
import { commandExists } from "./sysdeps.js";
import { registerSandboxCommands } from "./sandbox/cli.js";
import { registerAuthCommands } from "./cli/auth.js";
import { registerTicketCommands } from "./cli/ticket.js";
import { registerAdminCommands } from "./cli/admin.js";
import { registerAutopollCommands } from "./cli/autopoll.js";
import { registerBootstrapCommands } from "./cli/bootstrap.js";
import { registerConsumerCommands } from "./cli/consumer.js";
import { registerProviderCommands } from "./cli/providers.js";
import {
    URL,
    die,
    userCwd,
    jsonline,
    out,
    fmtStatus,
    buildClient,
    gOpts,
} from "./cli/_helpers.js";

// =====================================================================
// Program + global options
// =====================================================================

const program = new Command();
program
    .name("aiball")
    .description("CLI for the inter-agent BAL daemon")
    .version(AIBALL_VERSION, "-v, --version", "print the aiball version and exit")
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
registerConsumerCommands(program);
registerProviderCommands(program);

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
                        if (h.command && /aiball-autopoll-stop\.(sh|cmd)$/.test(h.command)) {
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
            // #269 (david ftprf7): runtime deps. python3 powers the
            // claude-loop PTY proxy (live human-typing detection + socket
            // wake injection); without it the loop falls back to direct
            // launch + pane-diff (idle-only). Same probe the proxy launch
            // uses (src/sysdeps.ts).
            dependencies: {
                python3: commandExists("python3"),
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
        process.stdout.write(`  ${ok(payload.stop_hook.wired)} wired: ${payload.stop_hook.wired ? payload.stop_hook.command : "no aiball-autopoll-stop entry"}\n`);
        if (!payload.stop_hook.wired) {
            process.stdout.write(`     enable with: aiball init --stop-hook            (project-local)\n`);
            process.stdout.write(`                   aiball init --stop-hook --global   (every Claude Code session)\n`);
        }
        process.stdout.write(`\ndaemon\n`);
        process.stdout.write(`  ${ok(payload.daemon.up)} reachable\n`);
        if (payload.daemon.up && payload.consumer.agent) {
            process.stdout.write(`  ${ok(payload.daemon.unread_pings === 0)} unread pings for ${payload.consumer.agent}: ${payload.daemon.unread_pings ?? "?"}\n`);
        }
        process.stdout.write(`\ndependencies\n`);
        process.stdout.write(
            `  ${ok(payload.dependencies.python3)} python3: ${
                payload.dependencies.python3
                    ? "available (claude-loop PTY proxy enabled)"
                    : "MISSING — claude-loop falls back to direct launch (no live human-typing detection)"
            }\n`,
        );
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
// mcp + bootstrap init → ./cli/bootstrap.ts (#B.213 phase 3.F).
// =====================================================================
registerAuthCommands(program);
registerBootstrapCommands(program);

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
