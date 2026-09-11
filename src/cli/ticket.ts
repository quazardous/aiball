/**
 * `aiball ticket` command group (carved out of cli.ts in #B.213
 * phase 3.C on 2026-05-19). Behavior-preserving move.
 *
 * Subcommands: new, comment, close, move, approve-children, level, list, get, import, export
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

/**
 * #2180 — what `ticket approve-children` should do, as a pure verdict so a test
 * can see every branch (`die` exits the process).
 *
 * Approving is always a second gesture that names its ids: the listing prints
 * the exact command to run, and the approval carries only those ids. A child
 * attached between the listing and the approval is therefore never swept along
 * — which a bare `--yes` that re-reads "whatever is pending now" would do.
 */
export type ChildrenSweepVerdict =
    | { kind: "none" }
    | { kind: "preview"; count: number; command: string }
    | { kind: "go"; ids: number[] }
    | { kind: "bad-ids"; raw: string };
export function planChildrenSweep(input: {
    parentId: number;
    pendingIds: readonly number[];
    ids?: string;
}): ChildrenSweepVerdict {
    if (input.ids !== undefined) {
        const parts = input.ids.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
        const ids = parts.map(Number);
        if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
            return { kind: "bad-ids", raw: input.ids };
        }
        return { kind: "go", ids: [...new Set(ids)] };
    }
    if (input.pendingIds.length === 0) return { kind: "none" };
    return {
        kind: "preview",
        count: input.pendingIds.length,
        command: `aiball --human ticket approve-children --id ${input.parentId} --ids ${input.pendingIds.join(",")}`,
    };
}

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
        .command("import <ref>")
        .description("Import an external issue (e.g. gh#123 or gh:owner/repo#123) as a coupled ticket")
        .option("--project <project>", "Project (default $AIBALL_PROJECT)")
        .action(async (ref: string, opts, cmd) => {
            const globalOpts = gOpts(cmd);
            const client = buildClient(globalOpts);
            const project = withProject(client, opts.project);
            const res = await client.importUpstream(ref, project);
            out(res, globalOpts, (v) => {
                const r = v as {
                    ticket: { id: number; title: string | null };
                    external: { url: string; state: string };
                    provider: string;
                };
                return `imported #${r.ticket.id} ← ${r.provider} ${r.external.url} [${r.external.state}]\n  ${r.ticket.title ?? ""}`;
            });
        });

    ticket
        .command("export <id>")
        .description("Export a ticket UP to a new GitHub issue and couple it (writes to the remote)")
        .option("--repo <owner/repo>", "Target repo override (default: project's default binding)")
        .option("--yes", "Confirm the remote write (required — export creates a public issue)")
        .action(async (id: string, opts, cmd) => {
            const globalOpts = gOpts(cmd);
            if (!opts.yes) {
                die("ticket export creates a PUBLIC issue on the remote — re-run with --yes to confirm.");
            }
            const client = buildClient(globalOpts);
            const res = await client.exportUpstream(Number(id), opts.repo ? { repo: opts.repo } : {});
            out(res, globalOpts, (v) => {
                const r = v as {
                    ticket: { id: number };
                    external: { url: string; num: number };
                    provider: string;
                };
                return `exported ticket #${r.ticket.id} → ${r.provider} issue #${r.external.num}\n  ${r.external.url}`;
            });
        });

    // #2172 — the CLI could not move a ticket between projects, while the MCP
    // tool and the web UI both could. Same route as those two
    // (`POST /tickets/:id/move`), so the audit comment the move leaves on the
    // thread, the permission check and the ping fan-out are identical here.
    ticket
        .command("move")
        .description("Move a ticket to another project (leaves an audit comment on the thread)")
        .requiredOption("--id <id>", "Ticket id")
        .requiredOption("--to <project>", "Destination project")
        .action(async (opts: { id: string; to: string }, cmd) => {
            const client = buildClient(gOpts(cmd));
            const id = Number(opts.id);
            // Read the source project BEFORE moving: `moveTicketTo` returns the
            // ticket alone, so the response cannot say where it came from, and
            // a receipt that only names the destination is half a receipt. It
            // also fails early and clearly on an id that does not exist.
            let from: string | undefined;
            try {
                from = ((await client.getMessage(id)) as { project?: string })?.project;
            } catch {
                /* the move below reports the real error */
            }
            const r = await client.moveTicket(id, opts.to) as { project?: string };
            out({ ...r, from }, gOpts(cmd), (x) =>
                `ticket #${id} moved${from ? ` from "${from}"` : ""} to "${(x as { project?: string }).project ?? opts.to}"`);
        });

    // #2180 — approve a ticket's pending children in one gesture, after seeing
    // them. Without --ids it only lists, naming who attached each child; with
    // --ids it approves those and nothing else (the daemon re-checks each one).
    ticket
        .command("approve-children")
        .description("List a ticket's pending children and who attached them; --ids approves exactly those (human only)")
        .requiredOption("--id <id>", "Parent ticket id")
        .option("--ids <list>", "Comma-separated child ids to approve, as printed by the listing")
        .action(async (opts: { id: string; ids?: string }, cmd) => {
            const client = buildClient(gOpts(cmd));
            const id = Number(opts.id);
            const { children } = await client.pendingChildren(id);
            const verdict = planChildrenSweep({
                parentId: id,
                pendingIds: children.map((c) => c.ticket_id),
                ids: opts.ids,
            });
            switch (verdict.kind) {
                case "bad-ids":
                    die(`--ids must be a comma-separated list of ticket ids, got "${verdict.raw}"`);
                case "none":
                    out({ ticket_id: id, children }, gOpts(cmd), () => `ticket #${id} has no pending children`);
                    return;
                case "preview":
                    out({ ticket_id: id, children }, gOpts(cmd), () => [
                        `ticket #${id} has ${verdict.count} pending child(ren):`,
                        ...children.map((c) =>
                            `  #${c.ticket_id} [${c.project}] ${c.title}\n      attached by ${c.attached_by ?? "system"} at ${c.attached_at}`),
                        "",
                        "to approve exactly these:",
                        `  ${verdict.command}`,
                    ].join("\n"));
                    return;
                case "go": {
                    const r = await client.approvePendingChildren(id, verdict.ids);
                    out(r, gOpts(cmd), (x) => [
                        `approved ${x.approved.length} child(ren) of #${id}${x.approved.length ? ": " + x.approved.map((n) => `#${n}`).join(", ") : ""}`,
                        ...x.skipped.map((s) => `  #${s.ticket_id} skipped: ${s.reason}`),
                    ].join("\n"));
                    return;
                }
            }
        });

    // #2216 — set a ticket's level. Human only: the daemon refuses an agent.
    ticket
        .command("level")
        .description("Set a ticket's level: task (default), milestone or roadmap — coder agents work on tasks, cto agents on milestones and roadmap (human only)")
        .requiredOption("--id <id>", "Ticket id")
        .requiredOption("--to <level>", "task | milestone | roadmap")
        .action(async (opts: { id: string; to: string }, cmd) => {
            if (opts.to !== "task" && opts.to !== "milestone" && opts.to !== "roadmap") die(`--to must be task, milestone or roadmap, got "${opts.to}"`);
            const client = buildClient(gOpts(cmd));
            const r = await client.setTicketLevel(Number(opts.id), opts.to as "task" | "milestone" | "roadmap") as { level?: string; warning?: string };
            out(r, gOpts(cmd), (x) => `ticket #${opts.id} level: ${x.level ?? opts.to}${x.warning ? `\n  warning: ${x.warning}` : ""}`);
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
