#!/usr/bin/env tsx
/**
 * aiball CLI — replaces the legacy bash bin/aiball entry. Uses commander
 * for dispatch and shares the same HTTP/spool semantics with the rest of
 * the codebase through {@link AiballClient}.
 *
 * Global flag --human / -H swaps the active consumer to $AIBALL_HUMAN
 * (default "human"), so a single CLI invocation can play either side.
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { AiballClient } from "./client.js";
import { registerSandboxCommands } from "./sandbox/cli.js";

const URL = process.env.AIBALL_URL ?? "http://127.0.0.1:7777";

function die(msg: string): never {
    process.stderr.write(`aiball: ${msg}\n`);
    process.exit(1);
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
    .action((_opts, cmd) => {
        const globalOpts = gOpts(cmd);
        const client = buildClient(globalOpts);
        let source: string;
        if (globalOpts.human) source = "--human flag ($AIBALL_HUMAN)";
        else if (process.env.AIBALL_AGENT) source = "$AIBALL_AGENT env";
        else source = "sha256(pwd)";
        jsonline({
            consumer_id: client.agentId,
            cwd: process.cwd(),
            source,
            human: globalOpts.human === true,
            default_project: process.env.AIBALL_PROJECT ?? null,
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
// sandbox subcommands (delegated)
// =====================================================================

registerSandboxCommands(program);

// =====================================================================
// Run
// =====================================================================

program.parseAsync(process.argv).catch((e) => {
    die((e as Error).message);
});
