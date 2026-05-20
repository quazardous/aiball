/**
 * `aiball ticket` command group (carved out of cli.ts in #B.213
 * phase 3.C on 2026-05-19). Behavior-preserving move.
 *
 * Subcommands: new, comment, close, list, get
 *
 * Exposed entry point: `registerTicketCommands(program)`.
 */
import type { Command } from "commander";
import {
    buildClient,
    die,
    fmtPostReceipt,
    fmtTicketList,
    fmtTicketThread,
    gOpts,
    out,
    withProject,
} from "./_helpers.js";

export function registerTicketCommands(program: Command): void {
    const ticket = program.command("ticket").description("Create / list / inspect tickets");

    ticket
        .command("new")
        .description("Create a new ticket")
        .requiredOption("--title <title>", "Ticket title")
        .option("--project <project>", "Project (default $AIBALL_PROJECT)")
        .option("--body <body>", "Ticket body")
        .option("--by <agent>", "Author override (default: resolved consumer id)")
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const project = withProject(client, opts.project);
            const res = await client.postMessage({
                project,
                kind: "ticket_created",
                title: opts.title,
                ...(opts.body ? { body: opts.body } : {}),
                by_agent: opts.by ?? client.agentId,
            });
            out(res, globalOpts, (v) => fmtPostReceipt(v, "ticket"));
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
            out(res, gOpts(cmd), (v) => fmtPostReceipt(v, "comment"));
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
            out(res, gOpts(cmd), (v) => fmtPostReceipt(v, "close"));
        });

    ticket
        .command("list")
        .description("List tickets (optionally filtered by project + status)")
        .option("--project <project>")
        .option("--status <status>", "pending|approved|rejected (uses /api/messages when set)")
        .action(async (opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            if (opts.status) {
                const q: Record<string, string | number | undefined> = {
                    kind: "ticket_created",
                    status: opts.status,
                };
                if (opts.project) q.project = opts.project;
                out(await client.listMessages(q), globalOpts, fmtTicketList);
            } else {
                const q: Record<string, string | undefined> = {};
                if (opts.project) q.project = opts.project;
                out(await client.listTickets(q), globalOpts, fmtTicketList);
            }
        });

    ticket
        .command("get <id>")
        .description("Fetch a ticket thread")
        .action(async (id: string, _opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            // Human view needs body + comments to be useful; JSON callers
            // keep the legacy summary shape (header + comment_count).
            const fetchFull = globalOpts.json !== true;
            const t = await client.getTicket(Number(id), fetchFull ? { summary: false } : {});
            out(t, globalOpts, fmtTicketThread);
        });
}
