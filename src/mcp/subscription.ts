/**
 * Subscription MCP tools (carved out of src/mcp.ts in #B.213 phase
 * 4.C on 2026-05-19). Behavior-preserving move.
 *
 * Tools: subscribe, unsubscribe.
 *
 * Exposed entry point: `registerSubscriptionTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

export function registerSubscriptionTools(server: McpServer): void {
    server.registerTool(
        "subscribe",
        {
            description:
                "Subscribe to a project (default) or to a specific ticket. Project subscriptions have a `role`:\n- `owner` (project maintainer) → pings on every ticket movement, internal or broadcast.\n- `follower` (default, external) → pings only on broadcast-flagged tickets, so internal dev chatter doesn't leak.\n\nTicket subscriptions are independent of role: explicitly following a thread always pings you on that thread regardless of broadcast state. Posting a message auto-subscribes the author to that ticket; you only need this tool to follow threads or projects you don't write in. Calling subscribe again with a different role on an existing project subscription updates the role.",
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
                role: z
                    .enum(["owner", "follower"])
                    .optional()
                    .describe(
                        "Project subs only: `owner` to receive every movement, `follower` (default) to receive only broadcast-flagged tickets. Pass this again to change role.",
                    ),
            },
        },
        async ({ project, ticket_id, catchup, role }) => {
            if (ticket_id !== undefined) {
                const res = await client.subscribeTicket(ticket_id);
                return asText({ kind: "ticket", ...((res as object) ?? {}) });
            }
            const proj = client.resolveProject(project);
            const sub = await client.subscribe(proj, catchup === true, role);
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
}
