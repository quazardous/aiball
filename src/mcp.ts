/**
 * aiball MCP server (stdio transport).
 *
 * Exposes a minimal-surface API (10 tools total) so any MCP-capable agent
 * can post tickets, follow threads, and consume activity without shelling
 * out. The split between "what's the daemon" (status), "who am I" (whoami),
 * and "what am I subscribed to" (my_subscriptions) is intentionally fused
 * into a single `whoami` tool — agents need everything at once on boot.
 *
 * Run as:
 *     tsx src/mcp.ts
 *
 * The agent's identity (consumer_id and default by_agent) is derived from:
 *   - $AIBALL_AGENT env var if set, OR
 *   - sha256(cwd) first 12 hex chars (stable per workspace dir)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AiballClient } from "./client.js";

const client = new AiballClient();

const server = new McpServer({
    name: "aiball",
    version: "0.2.0",
});

/**
 * Lightweight "is anything waiting for me" probe injected into every tool
 * response so the agent always sees, in passing, whether they should call
 * `unread` / `unread({ pings: true })`. Two cheap GETs (one count each).
 * Failures degrade silently — the tool result is still valid.
 */
async function microStatus(): Promise<{ unread_project: number; unread_pings: number; project: string | null }> {
    const proj = client.defaultProject;
    const [pjCount, pgCount] = await Promise.all([
        proj
            ? client
                .unreadCount(proj)
                .then((r) => r.count ?? 0)
                .catch(() => 0)
            : Promise.resolve(0),
        client
            .pingsCount()
            .then((r) => r.unread ?? 0)
            .catch(() => 0),
    ]);
    return { unread_project: pjCount, unread_pings: pgCount, project: proj };
}

async function asText(v: unknown) {
    const status = await microStatus();
    let payload: unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
        payload = { _status: status, ...(v as Record<string, unknown>) };
    } else {
        payload = { _status: status, result: v };
    }
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}

// ---- ticket lifecycle ------------------------------------------------------

server.registerTool(
    "ticket_new",
    {
        description:
            "Create a new ticket in a project. Falls back to the file spool if the daemon is down.",
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe(
                    "Project name (free-form). Defaults to $AIBALL_PROJECT if set.",
                ),
            title: z.string().describe("Ticket title"),
            body: z.string().optional().describe("Ticket body / description"),
            intent: z
                .enum(["panic", "request", "question", "fyi"])
                .optional()
                .describe(
                    "panic = immediate blocker; question = needs an answer; request = action expected (default intent); fyi = informational, no action expected.",
                ),
            by_agent: z
                .string()
                .optional()
                .describe("Author identity. Defaults to the resolved agent id."),
        },
    },
    async ({ project, title, body, intent, by_agent }) => {
        const res = await client.postMessage({
            project: client.resolveProject(project),
            kind: "ticket_created",
            title,
            body,
            intent,
            by_agent: by_agent ?? client.agentId,
        });
        return asText(res);
    },
);

server.registerTool(
    "ticket_reply",
    {
        description:
            "Post a reply within a ticket thread. `target_id` is either a ticket id (→ top-level comment on the ticket) or a comment id (→ nested reply to that specific comment, Gmail-style). Both produce a comment_added; only parent_id differs.",
        inputSchema: {
            target_id: z
                .number()
                .int()
                .describe(
                    "Either a ticket id (to comment on the ticket itself) or a comment id (to reply to that specific comment within the thread).",
                ),
            body: z.string().describe("Reply body"),
            project: z
                .string()
                .optional()
                .describe("Project name. Required for offline (spool) mode."),
            by_agent: z.string().optional(),
        },
    },
    async ({ target_id, body, project, by_agent }) => {
        const target = (await client.getMessage(target_id)) as {
            project: string;
            kind: string;
            id: number;
            ticket_id: number | null;
        };
        let ticketId: number;
        let parentId: number;
        if (target.kind === "ticket_created") {
            ticketId = target.id;
            parentId = target.id;
        } else if (target.kind === "comment_added" && target.ticket_id !== null) {
            ticketId = target.ticket_id;
            parentId = target.id;
        } else {
            throw new Error(
                `target ${target_id} is not a valid reply target (kind=${target.kind})`,
            );
        }
        const proj = project ?? target.project;
        const res = await client.postMessage({
            project: proj,
            kind: "comment_added",
            ticket_id: ticketId,
            parent_id: parentId,
            body,
            by_agent: by_agent ?? client.agentId,
        });
        return asText(res);
    },
);

server.registerTool(
    "ticket_close",
    {
        description: "Close a ticket (the thread stays accessible, but ticket_list --open hides it).",
        inputSchema: {
            ticket_id: z.number().int(),
            project: z.string().optional(),
            by_agent: z.string().optional(),
        },
    },
    async ({ ticket_id, project, by_agent }) => {
        let proj = project;
        if (!proj) {
            try {
                const t = (await client.getMessage(ticket_id)) as { project: string };
                proj = t.project;
            } catch {
                proj = client.defaultProject ?? undefined;
                if (!proj) {
                    throw new Error(
                        "project required (daemon unreachable; set AIBALL_PROJECT or pass project)",
                    );
                }
            }
        }
        const res = await client.postMessage({
            project: proj,
            kind: "ticket_closed",
            ticket_id,
            parent_id: ticket_id,
            by_agent: by_agent ?? client.agentId,
        });
        return asText(res);
    },
);

server.registerTool(
    "ticket_list",
    {
        description:
            "List approved tickets, optionally filtered by project. Use ticket_get to fetch comments of one ticket.",
        inputSchema: {
            project: z.string().optional(),
            open: z
                .boolean()
                .optional()
                .describe("If true, only tickets that have not been closed."),
        },
    },
    async ({ project, open }) => {
        const list = await client.listTickets({
            project,
            open: open ? "1" : undefined,
        });
        return asText(list);
    },
);

server.registerTool(
    "ticket_get",
    {
        description: "Get a ticket header + all approved comments (the full thread).",
        inputSchema: { ticket_id: z.number().int() },
    },
    async ({ ticket_id }) => {
        return asText(await client.getTicket(ticket_id));
    },
);

// ---- subscriptions (project + ticket) -------------------------------------

server.registerTool(
    "subscribe",
    {
        description:
            "Subscribe to a project (default) or to a specific ticket. Project subscriptions deliver every approved message in that project to the outbox feed (cursor-based). Ticket subscriptions deliver pings (one per recipient, consumed independently). Posting a message auto-subscribes the author to that ticket; you only need this tool to follow threads you don't write in.",
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe(
                    "Project to subscribe to. Defaults to $AIBALL_PROJECT if neither project nor ticket_id is provided.",
                ),
            ticket_id: z
                .number()
                .int()
                .optional()
                .describe(
                    "Subscribe to a single ticket thread (cross-project). Mutually exclusive with `project`.",
                ),
            catchup: z
                .boolean()
                .optional()
                .describe(
                    "Project subs only: include backlog (last_seen_id starts at 0). Ignored for ticket subs.",
                ),
        },
    },
    async ({ project, ticket_id, catchup }) => {
        if (ticket_id !== undefined) {
            const res = await client.subscribeTicket(ticket_id);
            return asText({ kind: "ticket", ...((res as object) ?? {}) });
        }
        const proj = client.resolveProject(project);
        const sub = await client.subscribe(proj, catchup === true);
        const fp = await client.feedPath(proj);
        return asText({
            kind: "project",
            consumer_id: client.agentId,
            project: proj,
            subscription: sub,
            feed_path: fp.path,
            monitor_command: `tail -F -n 0 ${fp.path}`,
        });
    },
);

server.registerTool(
    "unsubscribe",
    {
        description:
            "Unsubscribe from a project or a specific ticket. Pass exactly one of project/ticket_id; defaults to AIBALL_PROJECT if both are omitted.",
        inputSchema: {
            project: z.string().optional(),
            ticket_id: z.number().int().optional(),
        },
    },
    async ({ project, ticket_id }) => {
        if (ticket_id !== undefined) {
            const res = await client.unsubscribeTicket(ticket_id);
            return asText({ kind: "ticket", ...((res as object) ?? {}) });
        }
        const proj = client.resolveProject(project);
        await client.unsubscribe(proj);
        return asText({
            kind: "project",
            unsubscribed: true,
            project: proj,
            consumer_id: client.agentId,
        });
    },
);

// ---- inbox (project feed + personal pings, plus optional ack) -------------

server.registerTool(
    "unread",
    {
        description:
            "Pull approved messages this agent hasn't seen yet. Default mode is the project feed (set with project, or $AIBALL_PROJECT). Pass pings=true to read personal pings (lineage-based notifications across every ticket you participated in or explicitly follow). Set mark_read=true to ack in the same call — only the messages returned in this very response are acked, never anything the agent didn't see. To paginate through a large backlog: keep calling with mark_read=true until the response comes back empty. There is no way to advance the cursor past unseen content from this tool — that would defeat the purpose of an inbox. Pass peek=true to inspect without ever flipping seen state, even if mark_read is set (safe for scripts and dry runs). Self-pings (the agent's own posts) are filtered out of every variant — if you need to track your own pending posts, use poll().my_pending_tickets.",
        inputSchema: {
            project: z.string().optional(),
            pings: z
                .boolean()
                .optional()
                .describe(
                    "If true, return personal pings instead of the project feed. Project arg is ignored.",
                ),
            limit: z.number().int().min(1).max(500).optional(),
            mark_read: z
                .boolean()
                .optional()
                .describe(
                    "If true, mark the returned messages as read in the same call (= ack the slice you just received, derived from the max id in the response). Calling this with no messages returned is a no-op. Suppressed when peek=true.",
                ),
            peek: z
                .boolean()
                .optional()
                .describe(
                    "Read-only inspection. Forces no state mutation regardless of mark_read. Useful for dry runs, scripts that snapshot state, or debugging the inbox.",
                ),
        },
    },
    async ({ project, pings, limit, mark_read, peek }) => {
        const shouldAck = mark_read === true && peek !== true;
        if (pings === true) {
            const data = (await client.listPings({
                unreadOnly: true,
                limit: limit ?? 100,
            })) as { pings?: Array<{ message_id: number }> } | undefined;
            if (shouldAck) {
                // Per-message ack: only the rows we actually returned to the
                // agent are marked seen. No way to skip-ahead past unseen
                // content.
                for (const p of data?.pings ?? []) {
                    await client.markPingsRead({ upToId: p.message_id });
                }
            }
            return asText({ kind: "pings", peek: peek === true, ...((data as object) ?? {}) });
        }
        const proj = client.resolveProject(project);
        const data = (await client.unread(proj, limit ?? 100)) as
            | { messages?: Array<{ id: number }> }
            | undefined;
        if (shouldAck) {
            // Per-message ack: each id received is marked seen on its own
            // row in the pings table. Pending-then-approved messages still
            // reach this agent on a later call because pings are inserted at
            // approval time, not at submission.
            for (const m of data?.messages ?? []) {
                await client.markMessageSeen(m.id);
            }
        }
        return asText({ kind: "project", peek: peek === true, ...((data as object) ?? {}) });
    },
);

// ---- poll: agent context + what's waiting --------------------------------

server.registerTool(
    "poll",
    {
        description:
            "Snapshot of the agent's context AND what's waiting for them. Call this on session boot AND any time you want to see if anything new requires attention. Returns: identity, daemon health, subscriptions (project + ticket), known projects, your own pending tickets (waiting for moderation), and your unread ping count. (Replaces the older `whoami` / `status` / `my_subscriptions` / `list_projects` quartet.)",
        inputSchema: {},
    },
    async () => {
        const [daemon, projectSubs, ticketSubs, knownProjects, myPending, pingCount] =
            await Promise.all([
                client.health().then(
                    (info) => ({ up: true as const, ...((info as object) ?? {}) }),
                    (e) => ({ up: false as const, error: (e as Error).message }),
                ),
                client.mySubs().catch(() => []),
                client.myTicketSubs().catch(() => ({ subscriptions: [] })),
                client.listProjects().catch(() => []),
                client.myPendingTickets().catch(() => []),
                client.pingsCount().catch(() => ({ unread: 0 })),
            ]);
        return asText({
            consumer_id: client.agentId,
            cwd: process.cwd(),
            source: process.env.AIBALL_AGENT ? "AIBALL_AGENT env" : "sha256(cwd)",
            default_project: client.defaultProject,
            daemon,
            project_subscriptions: projectSubs,
            ticket_subscriptions:
                (ticketSubs as { subscriptions?: unknown[] }).subscriptions ?? ticketSubs,
            known_projects: knownProjects,
            my_pending_tickets: myPending,
            unread_pings: (pingCount as { unread?: number }).unread ?? 0,
        });
    },
);

// ---- start ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// If the agent has an explicit project (AIBALL_PROJECT, typically set in
// .mcp.json env), auto-subscribe at startup so the agent's outbox feed
// starts collecting messages immediately. upsertSubscription is idempotent,
// so this is safe to call on every MCP launch. We intentionally do NOT pass
// catchup=true: the agent should see new messages from now on, not the full
// history of the project.
if (client.defaultProject) {
    client.subscribe(client.defaultProject, false).catch(() => {
        // Daemon may be down at MCP startup; the agent will hit the spool
        // path on its next post and the subscription registers later when
        // the daemon comes back. Don't crash the MCP for this.
    });
}
