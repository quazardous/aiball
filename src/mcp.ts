/**
 * aiball MCP server (stdio transport).
 *
 * Exposes a minimal-surface API (12 tools total) so any MCP-capable agent
 * can post tickets, follow threads, and consume activity without shelling
 * out. Tool clusters live under ./mcp/* — see registerXxxTools imports
 * below. This file stays a thin orchestrator: helpers + server creation
 * + tool registration + startup auto-subscribe + stdio connect.
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
import { client } from "./mcp/_helpers.js";
import { registerTicketWriteTools } from "./mcp/ticket-write.js";
import { registerTicketReadTools } from "./mcp/ticket-read.js";
import { registerSubscriptionTools } from "./mcp/subscription.js";
import { registerInboxTools } from "./mcp/inbox.js";

const server = new McpServer({
    name: "aiball",
    version: "0.2.0",
});

// Tool clusters (#B.213 phase 4 — extracted from this file).
registerTicketWriteTools(server);
registerTicketReadTools(server);
registerSubscriptionTools(server);
registerInboxTools(server);

// ---- start ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// If the agent has an explicit project (AIBALL_PROJECT, typically set in
// .mcp.json env), auto-subscribe at startup so the agent's outbox feed
// starts collecting messages immediately. The role is **owner**: an agent
// identified by AIBALL_PROJECT=foo is the maintainer of foo and should
// see every movement on it, not just broadcast-flagged tickets. Cross-
// project subscriptions (manual `subscribe({ project: "other" })`) keep
// the default "follower" role unless the caller passes role=owner.
// upsertSubscription is idempotent — it updates the role if it differs,
// so this is safe to call on every MCP launch.
if (client.defaultProject) {
    client.subscribe(client.defaultProject, false, "owner").catch(() => {
        // Daemon may be down at MCP startup; the agent will hit the spool
        // path on its next post and the subscription registers later when
        // the daemon comes back. Don't crash the MCP for this.
    });
}
