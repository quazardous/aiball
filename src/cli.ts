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
import { basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { AiballClient } from "./client.js";
import { registerSandboxCommands } from "./sandbox/cli.js";
import {
    issueToken,
    listTokens,
    deleteToken,
    getConsumer,
    anyHumanCredentials,
} from "./db.js";

const URL = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";

function die(msg: string): never {
    process.stderr.write(`aiball: ${msg}\n`);
    process.exit(1);
}

/**
 * The invoker's working directory. `bin/aiball` does `cd "$ROOT"`
 * before exec'ing tsx, which corrupts `process.cwd()`. The wrapper
 * preserves the original PWD in AIBALL_CWD so commands that walk
 * up from the project (autopoll, check, …) see the right tree.
 */
function userCwd(): string {
    return process.env.AIBALL_CWD ?? process.cwd();
}

/** Print a value as JSON line; preserves the existing bash CLI contract. */
function jsonline(value: unknown): void {
    process.stdout.write(JSON.stringify(value) + "\n");
}

/** Resolve the active consumer id, honouring --human and AIBALL_AGENT. */
function buildClient(globalOpts: { human?: boolean }): AiballClient {
    if (globalOpts.human) {
        const human = process.env.AIBALL_HUMAN ?? "human";
        return new AiballClient({ agentId: human });
    }
    return new AiballClient();
}

function withProject(client: AiballClient, project: string | undefined): string {
    try {
        return client.resolveProject(project);
    } catch (e) {
        die((e as Error).message);
    }
}

interface GlobalOpts {
    human?: boolean;
}
function gOpts(cmd: Command): GlobalOpts {
    // Walk up to root so subcommand contexts inherit --human.
    let p: Command | null = cmd;
    while (p && p.parent) p = p.parent;
    return (p?.opts() ?? {}) as GlobalOpts;
}

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
    );

// =====================================================================
// ticket subcommands
// =====================================================================

const ticket = program.command("ticket").description("Create / list / inspect tickets");

ticket
    .command("new")
    .description("Create a new ticket")
    .requiredOption("--title <title>", "Ticket title")
    .option("--project <project>", "Project (default $AIBALL_PROJECT)")
    .option("--body <body>", "Ticket body")
    .option("--by <agent>", "Author override (default: resolved consumer id)")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = withProject(client, opts.project);
        const res = await client.postMessage({
            project,
            kind: "ticket_created",
            title: opts.title,
            ...(opts.body ? { body: opts.body } : {}),
            by_agent: opts.by ?? client.agentId,
        });
        jsonline(res);
    });

ticket
    .command("comment")
    .description("Post a comment on a ticket")
    .requiredOption("--id <id>", "Ticket id")
    .requiredOption("--body <body>", "Comment body")
    .option("--project <project>", "Project (auto-resolved from ticket if daemon is up)")
    .option("--parent <id>", "Parent message id (default: ticket id)")
    .option("--by <agent>", "Author override")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const ticketId = Number(opts.id);
        let project = opts.project as string | undefined;
        if (!project) {
            try {
                const m = (await client.getMessage(ticketId)) as { project?: string };
                project = m?.project;
            } catch {
                /* fall through */
            }
            project ??= process.env.AIBALL_PROJECT;
            if (!project) {
                die(
                    "ticket comment: --project required (daemon down, can't infer; or set AIBALL_PROJECT)",
                );
            }
        }
        const parent = opts.parent ? Number(opts.parent) : ticketId;
        const res = await client.postMessage({
            project,
            kind: "comment_added",
            body: opts.body,
            by_agent: opts.by ?? client.agentId,
            ticket_id: ticketId,
            parent_id: parent,
        });
        jsonline(res);
    });

ticket
    .command("close")
    .description("Close a ticket")
    .requiredOption("--id <id>", "Ticket id")
    .option("--project <project>", "Project (auto-resolved from ticket if daemon is up)")
    .option("--by <agent>", "Author override")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const ticketId = Number(opts.id);
        let project = opts.project as string | undefined;
        if (!project) {
            try {
                const m = (await client.getMessage(ticketId)) as { project?: string };
                project = m?.project;
            } catch {
                /* fall through */
            }
            project ??= process.env.AIBALL_PROJECT;
            if (!project) {
                die(
                    "ticket close: --project required (daemon down, can't infer; or set AIBALL_PROJECT)",
                );
            }
        }
        const res = await client.postMessage({
            project,
            kind: "ticket_closed",
            by_agent: opts.by ?? client.agentId,
            ticket_id: ticketId,
            parent_id: ticketId,
        });
        jsonline(res);
    });

ticket
    .command("list")
    .description("List tickets (optionally filtered by project + status)")
    .option("--project <project>")
    .option("--status <status>", "pending|approved|rejected (uses /api/messages when set)")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        if (opts.status) {
            const q: Record<string, string | number | undefined> = {
                kind: "ticket_created",
                status: opts.status,
            };
            if (opts.project) q.project = opts.project;
            jsonline(await client.listMessages(q));
        } else {
            const q: Record<string, string | undefined> = {};
            if (opts.project) q.project = opts.project;
            jsonline(await client.listTickets(q));
        }
    });

ticket
    .command("get <id>")
    .description("Fetch a ticket thread")
    .action(async (id: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        jsonline(await client.getTicket(Number(id)));
    });

// =====================================================================
// rule subcommands
// =====================================================================

const rule = program.command("rule").description("Moderation rule engine");

rule.command("list").action(async (_opts, cmd) => {
    const client = buildClient(gOpts(cmd));
    jsonline(await client.listRules());
});

rule
    .command("add")
    .requiredOption("--decision <decision>", "auto|review")
    .option("--project <project>")
    .option("--kind <kind>")
    .option("--by <agent>")
    .option("--note <note>")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const r = await client.addRule({
            decision: opts.decision as "auto" | "review",
            ...(opts.project ? { match_project: opts.project } : {}),
            ...(opts.kind ? { match_kind: opts.kind } : {}),
            ...(opts.by ? { match_by_agent: opts.by } : {}),
            ...(opts.note ? { note: opts.note } : {}),
        });
        jsonline(r);
    });

rule
    .command("del <id>")
    .description("Delete a rule")
    .action(async (id: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        jsonline(await client.deleteRule(Number(id)));
    });

rule
    .command("enable <id>")
    .description("Enable a rule")
    .action(async (id: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        jsonline(await client.toggleRule(Number(id), true));
    });

rule
    .command("disable <id>")
    .description("Disable a rule")
    .action(async (id: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        jsonline(await client.toggleRule(Number(id), false));
    });

// =====================================================================
// project + feed-path
// =====================================================================

const project = program.command("project").description("Project listing");
project.command("list").action(async (_opts, cmd) => {
    const client = buildClient(gOpts(cmd));
    jsonline(await client.listProjects());
});

program
    .command("feed-path <project>")
    .description("Print the outbox feed path for tail -F")
    .action(async (proj: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const r = (await client.feedPath(proj)) as { path: string };
        process.stdout.write(r.path + "\n");
    });

// =====================================================================
// whoami / subscriptions / unread
// =====================================================================

program
    .command("whoami")
    .description("Print the consumer_id used here")
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
        jsonline({
            consumer_id: client.agentId,
            cwd: userCwd(),
            source,
            human: globalOpts.human === true,
            default_project: client.defaultProject,
        });
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
        jsonline({
            consumer_id: client.agentId,
            project,
            feed_path: fp.path,
            subscription: sub,
            monitor_command: `tail -F -n 0 ${fp.path}`,
        });
    });

program
    .command("unsubscribe <project>")
    .description("Unsubscribe the current consumer from a project")
    .action(async (proj: string, _opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = client.resolveProject(proj);
        await client.unsubscribe(project);
        jsonline({ unsubscribed: true, consumer_id: client.agentId, project });
    });

program
    .command("subs")
    .description("List this consumer's subscriptions")
    .action(async (_opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        jsonline(await client.mySubs());
    });

program
    .command("unread")
    .description("Pull unseen messages for the current consumer")
    .option("--project <project>")
    .option("--limit <n>", "Max rows to return", "100")
    .action(async (opts, cmd) => {
        const client = buildClient(gOpts(cmd));
        const project = withProject(client, opts.project);
        jsonline(await client.unread(project, Number(opts.limit)));
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
        jsonline(
            await client.markReadProject({
                project,
                ...(opts.all ? { all: true } : {}),
                ...(opts.upTo ? { upToId: Number(opts.upTo) } : {}),
            }),
        );
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
    .description("Daemon up? Spool size? DB path?")
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
        jsonline({
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
        });
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

        if (opts.json) {
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
// auth subcommands (#B.94) — direct DB ops, no token needed
// =====================================================================

const auth = program.command("auth").description("Bootstrap + token management");

auth.command("init")
    .description(
        "First-time setup. Mints an install token + prints the URL to open in a browser. Refuses if humans are already configured (use `auth reinit` to force).",
    )
    .option("--port <port>", "Daemon port for the printed URL", String(URL.match(/:(\d+)/)?.[1] ?? "7777"))
    .option("--host <host>", "Hostname for the printed URL", "127.0.0.1")
    .action((opts: { port: string; host: string }) => {
        if (anyHumanCredentials()) {
            die("auth init: already initialized. Use `aiball auth reinit` to force a fresh install token, or `aiball auth issue` to mint an agent token for a CLI/MCP client.");
        }
        const existing = listTokens({ kind: "install" });
        const t = existing.length > 0 ? existing[0] : issueToken({
            kind: "install",
            label: "first-time init",
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        });
        const setupUrl = `http://${opts.host}:${opts.port}/setup?t=${t.token}`;
        process.stdout.write([
            `aiball is ready for setup.`,
            ``,
            `  Open: ${setupUrl}`,
            ``,
            `Choose your login + password in the web form. The install token`,
            `is one-shot and expires after 24h.`,
            ``,
        ].join("\n"));
    });

auth.command("reinit")
    .description(
        "Force a fresh install token even if humans are already configured. Useful for password reset or onboarding a second human.",
    )
    .option("--port <port>", "Daemon port for the printed URL", String(URL.match(/:(\d+)/)?.[1] ?? "7777"))
    .option("--host <host>", "Hostname for the printed URL", "127.0.0.1")
    .action((opts: { port: string; host: string }) => {
        const t = issueToken({
            kind: "install",
            label: "reinit",
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        });
        const setupUrl = `http://${opts.host}:${opts.port}/setup?t=${t.token}`;
        process.stdout.write([
            `Fresh install token issued.`,
            ``,
            `  Open: ${setupUrl}`,
            ``,
            `One-shot, expires in 24h. Existing humans / sessions are untouched.`,
            ``,
        ].join("\n"));
    });

auth.command("issue")
    .description("Mint a long-lived agent token bound to a consumer. Used for CLI / MCP / sandbox clients.")
    .requiredOption("--consumer <id>", "Existing consumer_id to bind the token to")
    .option("--label <label>", "Human-readable label (e.g. 'laptop cli', 'sandbox-1')")
    .option(
        "--kind <kind>",
        "Token kind: 'agent' (default) or 'auth' (web-style, normally minted by /login)",
        "agent",
    )
    .action((opts: { consumer: string; label?: string; kind: string }) => {
        const c = getConsumer(opts.consumer);
        if (!c) die(`auth issue: consumer '${opts.consumer}' not found. Create it via Settings > Consumers or post a message first.`);
        if (opts.kind !== "agent" && opts.kind !== "auth") {
            die(`auth issue: --kind must be 'agent' or 'auth' (got '${opts.kind}')`);
        }
        const t = issueToken({
            consumer_id: opts.consumer,
            kind: opts.kind as "agent" | "auth",
            label: opts.label ?? null,
        });
        process.stdout.write([
            `Token issued for ${opts.consumer}:`,
            ``,
            `  ${t.token}`,
            ``,
            `Use it as: export AIBALL_TOKEN=${t.token}`,
            `(or pass Authorization: Bearer ${t.token} on each API call)`,
            ``,
        ].join("\n"));
    });

auth.command("list")
    .description("List every active token (install + auth + agent)")
    .action(() => {
        const rows = listTokens();
        if (rows.length === 0) {
            process.stdout.write("(no tokens)\n");
            return;
        }
        for (const t of rows) {
            const exp = t.expires_at ? ` expires=${t.expires_at}` : "";
            const last = t.last_used_at ? ` last=${t.last_used_at}` : " never used";
            const lbl = t.label ? ` "${t.label}"` : "";
            process.stdout.write(
                `${t.kind.padEnd(7)}  ${t.consumer_id ?? "(no consumer)"}  ${t.token}${lbl}${last}${exp}\n`,
            );
        }
    });

auth.command("revoke <token-or-prefix>")
    .description("Delete a token by its full string (or a unique prefix, e.g. 'aiball-abc1234')")
    .action((needle: string) => {
        const rows = listTokens();
        const matches = rows.filter((t) => t.token === needle || t.token.startsWith(needle));
        if (matches.length === 0) die(`auth revoke: no token matching '${needle}'`);
        if (matches.length > 1) {
            die(
                `auth revoke: prefix '${needle}' matches ${matches.length} tokens — be more specific:\n` +
                    matches.map((t) => `  ${t.token} (${t.kind})`).join("\n"),
            );
        }
        deleteToken(matches[0].token);
        process.stdout.write(`revoked ${matches[0].token}\n`);
    });

// =====================================================================
// autopoll subcommands — pilot per-project .aiball.yaml settings
// =====================================================================

const autopoll = program
    .command("autopoll")
    .description(
        "Manage the per-project autopoll hook (Stop → drain pings). Operates on the closest .aiball.yaml walking up from cwd.",
    );

autopoll
    .command("init")
    .description("Write a starter .aiball.yaml at cwd if none is found up-tree")
    .option("--force", "Overwrite an existing .aiball.yaml at cwd")
    .action(async (opts: { force?: boolean }) => {
        const { findConfigUpwards, CONFIG_FILENAME } = await import("./autopoll/config.js");
        const existing = findConfigUpwards(userCwd());
        const target = join(userCwd(), CONFIG_FILENAME);
        if (existing && !opts.force) {
            die(`already configured at ${existing} — re-run with --force to overwrite`);
        }
        // Resolve the install dir to find the example template.
        const installRoot = resolveInstallRoot();
        const example = join(installRoot, ".aiball.yaml.example");
        if (!existsSync(example)) {
            die(`example template missing at ${example}`);
        }
        writeFileSync(target, readFileSync(example, "utf8"));
        process.stdout.write(`wrote ${target}\nedit it or pilot via 'aiball autopoll {enable|disable|tone|throttle}'\n`);
    });

autopoll
    .command("show")
    .description("Print resolved autopoll settings for cwd")
    .action(async () => {
        const { loadConfig } = await import("./autopoll/config.js");
        const cfg = loadConfig(userCwd());
        jsonline({
            config_path: cfg.configPath,
            autopoll: cfg.autopoll,
            consumer: cfg.consumer,
        });
    });

autopoll
    .command("enable")
    .description("Set autopoll.enabled = true in .aiball.yaml")
    .action(async () => setAutopollField("enabled", true));

autopoll
    .command("disable")
    .description("Set autopoll.enabled = false in .aiball.yaml")
    .action(async () => setAutopollField("enabled", false));

autopoll
    .command("tone <value>")
    .description("Set autopoll.tone (hint | directive | imperative)")
    .action(async (value: string) => {
        if (value !== "hint" && value !== "directive" && value !== "imperative") {
            die(`unknown tone '${value}' (expected hint | directive | imperative)`);
        }
        await setAutopollField("tone", value);
    });

autopoll
    .command("throttle <seconds>")
    .description("Set autopoll.throttle_seconds (integer ≥ 0)")
    .action(async (seconds: string) => {
        const n = Number.parseInt(seconds, 10);
        if (!Number.isFinite(n) || n < 0) {
            die(`throttle must be a non-negative integer, got '${seconds}'`);
        }
        await setAutopollField("throttle_seconds", n);
    });

autopoll
    .command("volatile <value>")
    .description("Set autopoll.volatile (true = one-shot per ping, false = persistent reminders)")
    .action(async (value: string) => {
        const v = value.toLowerCase();
        if (v !== "true" && v !== "false") {
            die(`volatile must be true or false, got '${value}'`);
        }
        await setAutopollField("volatile", v === "true");
    });

autopoll
    .command("backlog <value>")
    .description(
        "Set autopoll.backlog (true = open-tickets count is also a notify trigger, not just context)",
    )
    .action(async (value: string) => {
        const v = value.toLowerCase();
        if (v !== "true" && v !== "false") {
            die(`backlog must be true or false, got '${value}'`);
        }
        await setAutopollField("backlog", v === "true");
    });

async function setAutopollField(key: string, value: unknown): Promise<void> {
    const { findConfigUpwards, CONFIG_FILENAME } = await import("./autopoll/config.js");
    const yamlMod = await import("yaml");
    let path = findConfigUpwards(userCwd());
    if (!path) {
        // Bootstrap: create a minimal .aiball.yaml at cwd so the user
        // doesn't have to run init separately.
        path = join(userCwd(), CONFIG_FILENAME);
        writeFileSync(path, "autopoll: {}\n");
        process.stdout.write(`created ${path}\n`);
    }
    const src = readFileSync(path, "utf8");
    const doc = yamlMod.parseDocument(src);
    if (!doc.has("autopoll")) doc.set("autopoll", { [key]: value });
    else doc.setIn(["autopoll", key], value);
    writeFileSync(path, doc.toString());
    process.stdout.write(`${path}: autopoll.${key} = ${JSON.stringify(value)}\n`);
}

// =====================================================================
// mcp subcommands — wire .mcp.json non-destructively (#B.175)
// =====================================================================

const mcp = program
    .command("mcp")
    .description("Manage the aiball entry in this project's .mcp.json");

mcp
    .command("init")
    .description("Add the aiball MCP server to .mcp.json at cwd (preserves any existing entries)")
    .option("--force", "Overwrite an existing aiball entry (drops any legacy env block — #B.154)")
    .action(async (opts: { force?: boolean }) => {
        const path = join(userCwd(), ".mcp.json");
        type McpFile = {
            mcpServers?: Record<string, unknown>;
        };
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
        if (had && !opts.force) {
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
        process.stdout.write(`\nNext: identity defaults to '${basename(userCwd())}-claude'. Override via .aiball.yaml consumer:* if needed.\n`);
    });

function resolveInstallRoot(): string {
    // The bin/aiball wrapper cd's into the install dir before exec'ing
    // tsx — process.cwd() at this point IS the install root. Easier
    // and faster than walking up looking for package.json.
    return process.cwd();
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
