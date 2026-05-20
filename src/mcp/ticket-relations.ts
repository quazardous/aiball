/**
 * Ticket-relation MCP tools (#275). Expose the typed inter-ticket
 * relation graph (#271 / #B.123) to agents.
 *
 * Until now an agent could only create a relation at ticket creation
 * (`ticket_new`'s `parent_id`) — never attach one a posteriori. Relations
 * existed in the model (`child_of` / `parent_of` / `depends_on` / `blocks`
 * / `relates_to` / `duplicates`, surfaced as chips and in `ticket_get`'s
 * `relations[]`) but the only write path was the UI / HTTP. These two
 * tools close the gap.
 *
 * Both call POST /api/tickets/:id/relations (append-only event log, same
 * path as the UI). The daemon enforces: self-relation, kind validity,
 * target existence, reporter-or-human permission, lineage cycle guard,
 * and idempotency — so the tools stay thin.
 *
 * Exposed entry point: `registerTicketRelationTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

export function registerTicketRelationTools(server: McpServer): void {
    server.registerTool(
        "ticket_relate",
        {
            description:
                "Create (or change the kind of) a typed relation between two tickets, authored on `ticket_id` and pointing at `target_id`. Mirrors the UI add-relation path (#271). Append-only & idempotent: re-posting the same active kind is a no-op; to change the kind, just call again with the new one (latest-per-target wins). To REMOVE a relation use `ticket_unrelate`.\n\nKinds:\n- `child_of` / `parent_of` — structural lineage (e.g. a bug split out of a parent ticket). Inert for actionable gating. Kept acyclic by the daemon (a cycle-closing edge is rejected, HTTP 409).\n- `depends_on` — this ticket can't proceed until the target closes; gates `actionable_count`. `blocks` is the inverse, posted from the blocker side.\n- `relates_to` — soft cross-reference, no workflow impact.\n- `duplicates` — this ticket duplicates the target (usually paired with a close).\n\nPermission (enforced daemon-side): a registered human moderator, or the reporter of EITHER ticket. Returns the refreshed `relations[]` for `ticket_id` (and `noop:true` when nothing changed).",
            inputSchema: {
                ticket_id: z
                    .number()
                    .int()
                    .describe("Source ticket id — the relation is authored on this ticket."),
                target_id: z
                    .number()
                    .int()
                    .describe("Target ticket id the relation points at."),
                kind: z
                    .enum([
                        "child_of",
                        "parent_of",
                        "depends_on",
                        "blocks",
                        "relates_to",
                        "duplicates",
                    ])
                    .describe(
                        "Relation kind. child_of/parent_of = lineage (acyclic, inert for gating); depends_on/blocks = blocking pair (gates actionable); relates_to = soft xref; duplicates = dedupe. Use ticket_unrelate to remove a link instead of passing a tombstone here.",
                    ),
            },
        },
        async ({ ticket_id, target_id, kind }) => {
            const res = await client.relate(ticket_id, target_id, kind);
            return asText(res);
        },
    );

    server.registerTool(
        "ticket_unrelate",
        {
            description:
                "Remove the relation from `ticket_id` to `target_id` (whatever its kind). Implemented as a tombstone event (`kind=ignored`) on the append-only log — the link drops out of both tickets' `relations[]`, and the audit trail is preserved. Idempotent: unrelating a pair that has no active edge is a no-op. Removes the edge as seen from `ticket_id`'s side (also suppresses a reciprocal edge authored from the other ticket). Same permission as `ticket_relate` (human moderator or reporter of either ticket). Returns the refreshed `relations[]`.",
            inputSchema: {
                ticket_id: z
                    .number()
                    .int()
                    .describe("Source ticket id whose relation to `target_id` should be removed."),
                target_id: z
                    .number()
                    .int()
                    .describe("Target ticket id to unlink from `ticket_id`."),
            },
        },
        async ({ ticket_id, target_id }) => {
            const res = await client.relate(ticket_id, target_id, "ignored");
            return asText(res);
        },
    );
}
