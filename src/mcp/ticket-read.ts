/**
 * Ticket-read MCP tools (carved out of src/mcp.ts in #B.213 phase
 * 4.B on 2026-05-19). Behavior-preserving move.
 *
 * Tools: ticket_list, search, ticket_get.
 *
 * Exposed entry point: `registerTicketReadTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

export function registerTicketReadTools(server: McpServer): void {
    server.registerTool(
        "ticket_list",
        {
            description:
                "List tickets, optionally filtered by project, tags, author, status, title substring, or `since` (created_at >= ISO8601). Snoozed tickets excluded by default when `open: true` — pass `include_snoozed: true` to surface them. **`actionable: true`** (#B.232 #234) is stricter than `open`: also excludes tickets with a pending resolution proposal, blocked tickets, and tickets gated by an open dependency — i.e. the candidate pool the wake-CTA points at. Tag filter is AND-semantic. **Default: header-only rows** (id, title, summary, status, parent, sub_count, tags) — no bodies. Pass `full: true` to include `body` per row. Use ticket_get for one full thread.\n\n**Order**: when filtering by `open: true` or `actionable: true`, results sort by priority desc (urgent → high → normal → low), then by id desc within each priority bucket — pick the first ticket to address the highest-priority work first (#B.222). Plain (no open/actionable filter) keeps id-desc insertion order so browse callers aren't impacted.",
            inputSchema: {
                project: z.string().optional(),
                open: z
                    .boolean()
                    .optional()
                    .describe("If true, only tickets that have not been closed."),
                actionable: z
                    .boolean()
                    .optional()
                    .describe("If true, only tickets where the agent actually has work to do: not closed, not snoozed, NOT in awaiting-validation state (no pending resolution/plan proposal), not blocked, not gated by an open dependency. Strictly tighter than `open: true`. Matches the actionable_count surfaced on the sidebar."),
                include_snoozed: z
                    .boolean()
                    .optional()
                    .describe("If true (and open=true), include tickets currently snoozed in the result. Default false."),
                tags: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Restrict to tickets carrying every named tag (AND). Case-sensitive match on tag name. Unknown tags silently match nothing.",
                    ),
                full: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, include `body` in each row. Default is summary mode (header only) since #B.87 — listings are typically index lookups.",
                    ),
                since: z
                    .string()
                    .optional()
                    .describe(
                        "ISO8601 timestamp. Filters to tickets whose created_at >= since. Useful for 'what landed in the last hour'. Date.parse-friendly strings accepted (e.g. '2026-05-12T13:00:00Z' or '2026-05-12').",
                    ),
                by_agent: z
                    .string()
                    .optional()
                    .describe(
                        "Restrict to tickets authored by this consumer_id. Useful for 'my tickets' / 'tickets posted by X'.",
                    ),
                status: z
                    .enum(["pending", "approved", "rejected", "any"])
                    .optional()
                    .describe(
                        "Filter by ticket moderation status. Default 'approved' (matches prior behavior). Pass 'any' for cross-status (e.g. to see your own pending).",
                    ),
                title_contains: z
                    .string()
                    .optional()
                    .describe(
                        "Case-insensitive substring match on the (edited) title. Lighter than `search` when you only need to find a ticket by name.",
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe("Max rows. Hard cap 500. Default unlimited."),
            },
        },
        async ({
            project,
            open,
            actionable,
            include_snoozed,
            tags,
            full,
            since,
            by_agent,
            status,
            title_contains,
            limit,
        }) => {
            const list = await client.listTickets({
                project,
                open: open ? "1" : undefined,
                actionable: actionable ? "1" : undefined,
                include_postponed: include_snoozed ? "1" : undefined,
                tags: tags && tags.length > 0 ? tags.join(",") : undefined,
                // Default (no flag) → summary mode on the API side. `full: true`
                // explicitly opts back into bodies.
                full: full === true ? "1" : undefined,
                since,
                by_agent,
                status,
                title_contains,
                limit: limit !== undefined ? String(limit) : undefined,
            });
            return asText(list);
        },
    );

    server.registerTool(
        "search",
        {
            description:
                "Full-text search over ticket titles, ticket bodies, and comment / lifecycle bodies. Backed by SQLite FTS5 with a **trigram tokenizer** (#285): case-insensitive, accent-insensitive, and **substring / fragment matching** — `broad` finds `broadcast`, and `cast` finds `broadcast` too (no longer whole-word only). Whitespace-separated tokens are AND-ed (so `search('hashid broadcast')` finds rows containing both); each token ≥3 chars is matched as a substring, 1-2 char tokens fall back to a LIKE filter. Returns at most `limit` hits sorted by FTS5 relevance (more relevant first). Each hit carries a `snippet` with `<mark>…</mark>` around the match, plus enough context (project, by_agent, created_at, kind=ticket|comment, hashid for comments) to render without an extra round-trip. Snoozed parent tickets are filtered out by default — pass `include_snoozed: true` to surface their hits. Use this instead of scrolling `ticket_list` when you remember a keyword but not a number.",
            inputSchema: {
                query: z.string().describe("Free-form text to look up. Special FTS5 syntax characters are stripped — pass plain words."),
                project: z.string().optional().describe("Scope to one project (default: all projects the consumer can see)."),
                open: z.boolean().optional().describe("If true, exclude rejected tickets from the hit list."),
                include_snoozed: z
                    .boolean()
                    .optional()
                    .describe("If true, include hits whose parent ticket is currently snoozed. Default false."),
                intent: z
                    .enum(["panic", "request", "question", "fyi"])
                    .optional()
                    .describe("Filter on intent of the parent ticket."),
                limit: z.number().int().min(1).max(200).optional().describe("Max hits to return. Default 50, hard cap 200."),
            },
        },
        async ({ query, project, open, intent, limit, include_snoozed }) => {
            const hits = await client.search({
                query,
                project,
                open,
                intent,
                limit,
                include_postponed: include_snoozed,
            });
            return asText(hits);
        },
    );

    server.registerTool(
        "ticket_get",
        {
            description:
                "Get a ticket. **Default: header only** (no body, no comments) + `comment_count` — cheap probe of state. Pass `full: true` for the full thread (header with body + all approved comments). Pass `brief: true` for the **agent-friendly read** (#B.130 + pivot-cut): header + body + the latest `summary_until` snapshot + every comment_added AFTER that snapshot with full bodies. Everything earlier is dropped — the pivot's contract (\"ticket state AFTER this comment\") guarantees those bodies are already captured in the snapshot line. Lifecycle events (closed/resolved/sub-added/etc.) are always kept regardless of position.\n\n**How to use brief efficiently**: read the pivot's `summary_until` line + every comment after it (full bodies). That's the canonical resume point. The response surfaces `pivot_comment_id` so you can see where the cut happened. If the thread has no agent snapshot anywhere (legacy, pure-human), brief falls back to keeping the last `tail` bodies intact (default 1) and collapsing earlier ones — same behaviour as pre-pivot. If you need a body that was dropped, re-fetch with `full: true`.\n\nPass `digest: true` for a bird's-eye scan: header + ordered `digest[]` of every comment's `summary_until` snapshot (most useful across multiple tickets). Optional `digest_limit: N` keeps just the last N snapshots. Lossy by design — no bodies, no human comments without snapshots. Ignored if `brief` is also set.\n\n**Attachments (#283):** full/brief reads include an `attachments[]` array resolving every `/uploads/<sha>.<ext>` image reference in the shown bodies — `{sha, ext, content_type, bytes, ref, uri, local}`. When `local` is true, `uri` is a `file://` path on this host you can open DIRECTLY with the Read tool (no need to hunt for where the upload lives on disk); when false, `uri`/`ref` is an HTTP path to fetch. So to view a pasted screenshot, read `attachments[].uri` rather than searching the filesystem.",
            inputSchema: {
                ticket_id: z.number().int(),
                full: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, return the full thread (body + comments). Default is summary mode (#B.87): the header only + a `comment_count` integer.",
                    ),
                brief: z
                    .boolean()
                    .optional()
                    .describe(
                        "Pivot-cut brief read. Finds the latest `meta.summary_until` snapshot in the thread, drops every comment_added BEFORE it (those are by contract already captured in the snapshot), and ships: header + body + the pivot's `summary_until` line + every comment AFTER the pivot with full bodies. Lifecycle events (closed/resolved/sub-added) always kept. Response includes `pivot_comment_id` so you see where the cut landed. Fallback when the thread has NO summary_until anywhere: legacy tail-keep — last `tail` bodies intact (default 1), older comments collapsed to summary_until-if-present. Strict superset of pre-pivot brief; never silently lossy.",
                    ),
                tail: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(
                        "Fallback-only (#B.202): when brief finds NO summary_until in the thread, keep the N most-recent comment bodies intact instead of just 1. Pure no-op when a pivot is found (pivot-cut already keeps every comment after the pivot with full body). Ignored when `brief` is not set.",
                    ),
                digest: z
                    .boolean()
                    .optional()
                    .describe(
                        "Bird's-eye digest: header + ordered `digest[]` of every comment's `summary_until` snapshot (id, hashid, by_agent, created_at, summary_until). Use to scan a long thread's STATE progression, or to peek at many tickets cheaply (5-10× lighter than brief on busy threads). Lossy by design: no bodies, no human comments without summaries. Ignored if `brief` is also set.",
                    ),
                digest_limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(
                        "Digest-mode only: keep just the last N snapshots instead of all. Useful to bound the response when a ticket has dozens of agent comments.",
                    ),
            },
        },
        async ({ ticket_id, full, brief, tail, digest, digest_limit }) => {
            return asText(
                await client.getTicket(ticket_id, {
                    summary: full !== true && brief !== true && digest !== true,
                    brief: brief === true,
                    tail,
                    digest: digest === true,
                    digest_limit,
                }),
            );
        },
    );
}
