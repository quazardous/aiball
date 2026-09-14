/**
 * #2454 david — an agent can hand a secret over on the board, through a
 * ticket's payload zone. "C'est bien mieux de donner un canal de partage
 * documenté que si des secrets sont déposés un peu partout."
 *
 * The access rule does not change: the reporter, the assignee and humans read
 * and write the values; a claimant does not, and an assignment — a human
 * gesture — is what opens it. The daemon enforces it; these tools only carry it.
 *
 * What these tools add is the guarantee that a value never enters a
 * transcript: `payload_set` reads a FILE on this host and `payload_dump` writes
 * one, answering with the path and the key names only. No value is ever a tool
 * argument or part of a tool answer — including in an error.
 *
 * Exposed entry point: `registerPayloadTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readDepositFile, writeDumpFile } from "../payload-files.js";
import { asText, client, markActiveTicket } from "./_helpers.js";

const ACCESS =
    "Values are readable and writable by the ticket's REPORTER, its ASSIGNEE and humans — a claimant is refused (403). If you need access and hold neither role, ask a human on the thread to assign you the ticket: the assignment is the grant.";

export function registerPayloadTools(server: McpServer): void {
    server.registerTool(
        "payload_show",
        {
            description:
                `The SHAPE of a ticket's payload zone — every key, public values in full, secret values reduced to a short prefix — and its access state. Safe to read and to quote. Anyone who can read the ticket may call it. ${ACCESS}`,
            inputSchema: {
                ticket_id: z.number().int().describe("The ticket carrying the payload."),
            },
        },
        async ({ ticket_id }) => asText(await client.ticketPayload(ticket_id)),
    );

    server.registerTool(
        "payload_set",
        {
            description:
                `Hand a secret (an API key, a credential, a configuration) over on the board: deposit or replace a ticket's payload FROM A FILE on this host — a JSON object of key → value. The values never pass through this call or its answer, so they never reach a transcript; keep that file out of any repository and delete it once deposited. Every key is SECRET unless named in \`public\`. Answers with the shape only. ${ACCESS} The ticket must be open. See docs/PAYLOADS.md.`,
            inputSchema: {
                ticket_id: z.number().int().describe("The ticket that carries the handover."),
                from_file: z.string().describe("Path on this host to a JSON object of key -> value. Its content is never echoed back, not even in an error."),
                public: z.array(z.string()).optional().describe("Key names that are NOT secret (an endpoint, a scope). Omit and every key is secret — the safe default."),
            },
        },
        async ({ ticket_id, from_file, public: publicKeys }) => {
            const payload = readDepositFile(from_file);
            markActiveTicket(ticket_id);
            const res = await client.setTicketPayload(ticket_id, payload, publicKeys ?? []);
            return asText(res);
        },
    );

    server.registerTool(
        "payload_dump",
        {
            description:
                `Receive a secret handed over on the board: write a ticket's payload VALUES into a file on this host (mode 0600). The values never appear in this tool's answer — it returns the path and the key names only. \`format: "env"\` MERGES into an existing file (it replaces or appends its own keys and leaves every other line alone), so dumping into a service's \`.env\` does not erase what is already there; \`json\` replaces the file. ${ACCESS} A closed ticket or a revoked payload answers with the reason. See docs/PAYLOADS.md.`,
            inputSchema: {
                ticket_id: z.number().int().describe("The ticket carrying the payload."),
                to_file: z.string().describe("Path on this host to write the values to."),
                format: z.enum(["json", "env"]).optional().describe("`env` merges KEY=value lines into an existing file; `json` (default) writes an object."),
            },
        },
        async ({ ticket_id, to_file, format }) => {
            const res = (await client.dumpTicketPayload(ticket_id)) as { payload: Record<string, unknown> };
            markActiveTicket(ticket_id);
            const written = writeDumpFile(to_file, res.payload, format ?? "json");
            return asText({
                ticket_id,
                path: written.path,
                format: written.format,
                keys: written.keys,
                merged: written.merged,
                note: "values written to the file only — they are not in this answer",
            });
        },
    );

    server.registerTool(
        "payload_revoke",
        {
            description:
                `Destroy a ticket's payload values once the secret is installed, keeping a trace that they existed (when, by whom, which key names). ${ACCESS}`,
            inputSchema: {
                ticket_id: z.number().int().describe("The ticket carrying the payload."),
            },
        },
        async ({ ticket_id }) => asText(await client.revokeTicketPayload(ticket_id)),
    );
}
