/**
 * Upstream coupling (GitHub / GitLab), phase 2 — the `ticket_import` (Slice 0)
 * and `ticket_export` (Slice 1) MCP tools. Manually couple an aiball ticket to
 * an external issue, in either direction.
 *
 * Thin wrappers over POST /api/tickets/import and POST /api/tickets/:id/export
 * (the daemon holds the host-level token). Manual only — there is no
 * auto-discovery; a project's aiball-only tickets are never touched.
 *
 * Exposed entry point: `registerTicketImportTool(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

export function registerTicketImportTool(server: McpServer): void {
    server.registerTool(
        "ticket_import",
        {
            description:
                "Import an external issue (GitHub today; GitLab/Gitea later) as a NEW coupled aiball ticket. The ticket carries the upstream link (kind/ref/num) so a later sync can keep them in step; its labels become aiball tags. MANUAL by design — there is no auto-discovery, and aiball-only tickets are never affected.\n\n`ref` accepts two forms:\n- bare `gh#123` — needs a default `github` binding in the project's `.aiball.yaml upstream:`.\n- explicit `gh:owner/repo#123` — self-contained, no binding required.\n\nIdempotent: re-importing an already-coupled issue fails (HTTP 409) and reports the existing ticket id instead of forking a duplicate. Auth for private repos is a host-level token read from `~/.config/aiball/config.yaml` (`upstream_auth.github.token`) — it is never passed through this tool. Returns the created ticket + the fetched issue snapshot.",
            inputSchema: {
                ref: z
                    .string()
                    .describe("External issue ref: bare `gh#123` (needs a default binding) or explicit `gh:owner/repo#123`."),
                project: z
                    .string()
                    .optional()
                    .describe("aiball project the imported ticket lands in. Defaults to the agent's project."),
            },
        },
        async ({ ref, project }) => {
            const proj = client.resolveProject(project);
            const res = await client.importUpstream(ref, proj);
            return asText(res);
        },
    );

    server.registerTool(
        "ticket_export",
        {
            description:
                "Export an existing aiball ticket UP to a NEW external issue (GitHub today) and couple the ticket to it. The issue takes the ticket's title/body; the ticket records the upstream link. ⚠️ This WRITES to the remote — it creates a public issue — so only call it as a deliberate, confirmed action.\n\nTarget repo: the project's default `github` binding in `.aiball.yaml upstream:`, or pass `repo: \"owner/repo\"` to override. Needs a write-scoped host token (`upstream_auth.github.token`). Refuses a ticket that is already coupled (unlink first) so it never forks a second remote issue. Returns the ticket + the created issue.",
            inputSchema: {
                ticket_id: z
                    .number()
                    .int()
                    .describe("The aiball ticket to export."),
                repo: z
                    .string()
                    .optional()
                    .describe("Optional `owner/repo` override; defaults to the project's default github binding."),
            },
        },
        async ({ ticket_id, repo }) => {
            const res = await client.exportUpstream(ticket_id, repo ? { repo } : {});
            return asText(res);
        },
    );
}
