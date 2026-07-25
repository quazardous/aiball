/**
 * aiball MCP server (stdio transport).
 *
 * Exposes a minimal-surface API (14 tools total) so any MCP-capable agent
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
import { registerTicketRelationTools } from "./mcp/ticket-relations.js";
import { registerTicketImportTool } from "./mcp/ticket-import.js";
import { shouldSurfaceUpstreamTools } from "./upstream-visibility.js";
import { registerSubscriptionTools } from "./mcp/subscription.js";
import { registerInboxTools } from "./mcp/inbox.js";
import { registerUploadTools } from "./mcp/upload.js";
import { registerWelcomeTools } from "./mcp/welcome.js";
import { AIBALL_VERSION } from "./version.js";

// `aiball-mcp --version` / `-v`: the launcher forwards argv through, so
// honor it before the stdio transport claims stdout.
if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
    process.stdout.write(AIBALL_VERSION + "\n");
    process.exit(0);
}

const server = new McpServer({
    name: "aiball",
    version: AIBALL_VERSION,
});

// Tool clusters (#B.213 phase 4 — extracted from this file).
registerTicketWriteTools(server);
registerTicketReadTools(server);
registerTicketRelationTools(server);
registerSubscriptionTools(server);
registerInboxTools(server);
registerUploadTools(server);
registerWelcomeTools(server);

// ---- start ----------------------------------------------------------------

// If the agent has an explicit project (AIBALL_PROJECT, typically set in
// .mcp.json env), auto-subscribe at startup so the agent's outbox feed
// starts collecting messages immediately. The role is **owner**: an agent
// identified by AIBALL_PROJECT=foo is the maintainer of foo and should
// see every movement on it, not just broadcast-flagged tickets. Cross-
// project subscriptions (manual `subscribe({ project: "other" })`) keep
// the default "follower" role unless the caller passes role=owner.
// upsertSubscription is idempotent — it updates the role if it differs,
// so this is safe to call on every MCP launch. Awaited (not fire-and-forget)
// so the upstream-tool gate below sees the role on a fresh agent's very
// first launch; a daemon-down failure just leaves the gate to fail closed.
//
// #1435 slice 1 — a **crew** agent (AIBALL_ROLE=crew) subscribes as a
// **follower**, not owner: crew is assignment-only, and this keeps it out of
// the owner-gated surfaces (e.g. the #1542 upstream tools below). `lead` /
// unset keep the historical owner subscription.
if (client.defaultProject) {
    const subRole = process.env.AIBALL_ROLE === "crew" ? "follower" : "owner";
    try {
        await client.subscribe(client.defaultProject, false, subRole);
    } catch {
        // Daemon may be down at MCP startup; the agent will hit the spool
        // path on its next post and the subscription registers later when
        // the daemon comes back. Don't crash the MCP for this.
    }
}

// #1542 — the upstream import/export tools surface ONLY when the agent's
// project has an upstream binding AND the agent is a project owner (the
// "lead"). Owner/follower is the only role model today, so owner == lead;
// this refines automatically to an explicit lead/crew split later, since crew
// won't hold the owner role. Fail-closed: if we can't verify (daemon down,
// etc.) the tools stay hidden — they need the daemon anyway.
try {
    const project = client.defaultProject;
    if (project) {
        const [cfg, subs] = await Promise.all([client.getConfig(), client.mySubs()]);
        const surface = shouldSurfaceUpstreamTools({
            project,
            upstream: cfg.upstream,
            subs: (subs as Array<{ project: string; role: string }>) ?? [],
        });
        if (surface) registerTicketImportTool(server);
    }
} catch {
    // fail-closed: leave the upstream tools unregistered
}

const transport = new StdioServerTransport();
await server.connect(transport);
