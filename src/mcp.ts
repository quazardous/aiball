/**
 * aiball MCP server (stdio transport).
 *
 * Exposes the aiball ticket BAL as MCP tools so any MCP-capable agent
 * (Claude Code, Claude Desktop, custom clients, etc.) can post tickets,
 * comment on threads, subscribe to projects, and consume unread messages
 * without ever shelling out.
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
    version: "0.1.0",
});

function asText(v: unknown) {
    return {
        content: [
            {
                type: "text" as const,
                text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
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
            project: z.string().describe("Project name (free-form, will be created on first use)"),
            title: z.string().describe("Ticket title"),
            body: z.string().optional().describe("Ticket body / description"),
            by_agent: z
                .string()
                .optional()
                .describe("Author identity. Defaults to the resolved agent id."),
        },
    },
    async ({ project, title, body, by_agent }) => {
        const res = await client.postMessage({
            project,
            kind: "ticket_created",
            title,
            body,
            by_agent: by_agent ?? client.agentId,
        });
        return asText(res);
    },
);

server.registerTool(
    "ticket_comment",
    {
        description:
            "Add a comment to a ticket. Set parent_id to nest under a specific comment (default: top-level under the ticket).",
        inputSchema: {
            ticket_id: z.number().int().describe("ID of the ticket being commented on"),
            body: z.string().describe("Comment body"),
            project: z
                .string()
                .optional()
                .describe("Project name. Required for offline (spool) mode."),
            parent_id: z
                .number()
                .int()
                .optional()
                .describe("Parent message id for nested replies. Defaults to ticket_id."),
            by_agent: z.string().optional(),
        },
    },
    async ({ ticket_id, body, project, parent_id, by_agent }) => {
        let proj = project;
        if (!proj) {
            try {
                const t = (await client.getMessage(ticket_id)) as { project: string };
                proj = t.project;
            } catch {
                throw new Error(
                    "project required (daemon unreachable, can't infer from ticket_id)",
                );
            }
        }
        const res = await client.postMessage({
            project: proj,
            kind: "comment_added",
            ticket_id,
            parent_id: parent_id ?? ticket_id,
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
                throw new Error("project required (daemon unreachable)");
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

// ---- subscriptions ---------------------------------------------------------

server.registerTool(
    "subscribe",
    {
        description:
            "Subscribe the current agent (consumer_id from cwd-hash or $AIBALL_AGENT) to a project. Returns the outbox file path so you can also tail it via Monitor for push delivery.",
        inputSchema: {
            project: z.string(),
            catchup: z
                .boolean()
                .optional()
                .describe(
                    "If true, last_seen_id starts at 0 → unread will include all backlog. Default: start at current head (no backlog).",
                ),
        },
    },
    async ({ project, catchup }) => {
        const sub = await client.subscribe(project, catchup === true);
        const fp = await client.feedPath(project);
        return asText({
            consumer_id: client.agentId,
            project,
            subscription: sub,
            feed_path: fp.path,
            monitor_command: `tail -F -n 0 ${fp.path}`,
        });
    },
);

server.registerTool(
    "unsubscribe",
    {
        description: "Unsubscribe the current agent from a project.",
        inputSchema: { project: z.string() },
    },
    async ({ project }) => {
        await client.unsubscribe(project);
        return asText({ unsubscribed: true, project, consumer_id: client.agentId });
    },
);

server.registerTool(
    "my_subscriptions",
    {
        description: "List the projects this agent is subscribed to.",
        inputSchema: {},
    },
    async () => asText(await client.mySubs()),
);

server.registerTool(
    "unread",
    {
        description:
            "Pull approved messages this agent hasn't seen yet for a given project. Does NOT mark them read — call mark_read after consuming.",
        inputSchema: {
            project: z.string(),
            limit: z.number().int().min(1).max(500).optional(),
        },
    },
    async ({ project, limit }) => {
        return asText(await client.unread(project, limit ?? 100));
    },
);

server.registerTool(
    "mark_read",
    {
        description:
            "Mark messages as read for the current agent in a project. Provide either up_to_id (mark everything ≤ this id) or all=true.",
        inputSchema: {
            project: z.string(),
            up_to_id: z.number().int().optional(),
            all: z.boolean().optional(),
        },
    },
    async ({ project, up_to_id, all }) => {
        if (up_to_id === undefined && all !== true) {
            throw new Error("provide up_to_id or all=true");
        }
        return asText(
            await client.markRead(project, {
                upToId: up_to_id,
                all: all === true,
            }),
        );
    },
);

// ---- introspection / admin -------------------------------------------------

server.registerTool(
    "whoami",
    {
        description:
            "Return the consumer_id this MCP uses, the cwd it derives it from, and whether $AIBALL_AGENT is overriding it.",
        inputSchema: {},
    },
    async () =>
        asText({
            consumer_id: client.agentId,
            cwd: process.cwd(),
            source: process.env.AIBALL_AGENT ? "AIBALL_AGENT env" : "sha256(cwd)",
        }),
);

server.registerTool(
    "list_projects",
    { description: "List all projects that have at least one message.", inputSchema: {} },
    async () => asText(await client.listProjects()),
);

server.registerTool(
    "list_rules",
    { description: "List moderation rules.", inputSchema: {} },
    async () => asText(await client.listRules()),
);

server.registerTool(
    "status",
    {
        description: "Daemon health, URL, data dir.",
        inputSchema: {},
    },
    async () => {
        try {
            return asText({ daemon_up: true, info: await client.health() });
        } catch (e) {
            return asText({ daemon_up: false, error: (e as Error).message });
        }
    },
);

// ---- start ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
