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
                "List tickets, optionally filtered by project, tags, author, status, title substring, or `since` (created_at >= ISO8601). **`actionable: true`** is stricter than `open`: also excludes tickets with a pending resolution proposal, blocked tickets, and tickets gated by an open dependency. Note it is NARROWER than the backlog wake's pool, which also surfaces follow-up / waiting-on-them / blocked threads so they don't vanish — a backlog wake on a non-actionable ticket is by design, not a bug. Tag filter is AND-semantic. **Default: header-only rows** (id, title, summary, status, parent, sub_count, tags, plus per-consumer `unread` + `actionable` + `claimable` booleans) — no bodies. Pass `full: true` to include `body` per row. Use ticket_get for one full thread.\n\n**Order**: results come back as a single WORK-ORDER list. Unread items first, then actionable (¬unread), then other open, closed at the bottom — and within each band: priority desc (urgent → low), then oldest-first as a tiebreak. Every row carries `unread` (≥1 unseen ping for you) and `actionable` (in your court) so you can slice the single list yourself — the sets are **nested: unread ⊂ actionable ⊂ open**. `open: true` / `actionable: true` just SUBSET the rows to that band ; the ordering still applies. Take the first row to work the top of your queue (explicit priority still wins).",
            inputSchema: {
                project: z.string().optional(),
                open: z
                    .boolean()
                    .optional()
                    .describe("If true, only tickets that have not been closed."),
                actionable: z
                    .boolean()
                    .optional()
                    .describe("If true, only tickets where the agent actually has work to do: not closed, NOT in awaiting-validation state (no pending resolution/plan proposal), not blocked, not gated by an open dependency. Strictly tighter than `open: true`. Matches the actionable_count surfaced on the sidebar."),
                claimable: z
                    .boolean()
                    .optional()
                    .describe("If true, only tickets you can CLAIM: `actionable` AND in a project you OWN (role=owner). Narrower than `actionable` — a follower-broadcast from a project you only follow is actionable/visible but NOT claimable (the work belongs to that project's owners). This is the exact set a bare `ticket_claim()` picks from. Every row also carries a per-consumer `claimable` boolean so you can slice the list yourself."),
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
            claimable,
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
                claimable: claimable ? "1" : undefined,
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
                "Full-text search over ticket titles, ticket bodies, and comment / lifecycle bodies. Backed by SQLite FTS5 with a trigram tokenizer: case-insensitive, accent-insensitive, and substring / fragment matching — `broad` finds `broadcast`, and `cast` finds `broadcast` too. Whitespace-separated tokens are AND-ed (so `search('hashid broadcast')` finds rows containing both); each token ≥3 chars is matched as a substring, 1-2 char tokens fall back to a LIKE filter. Returns at most `limit` hits sorted by FTS5 relevance (more relevant first). Each hit carries a `snippet` with `<mark>…</mark>` around the match, plus enough context (project, by_agent, created_at, kind=ticket|comment, hashid for comments) to render without an extra round-trip. Use this instead of scrolling `ticket_list` when you remember a keyword but not a number.",
            inputSchema: {
                query: z.string().describe("Free-form text to look up. Special FTS5 syntax characters are stripped — pass plain words."),
                project: z.string().optional().describe("Scope to one project (default: all projects the consumer can see)."),
                open: z.boolean().optional().describe("If true, exclude rejected tickets from the hit list."),
                intent: z
                    .enum(["panic", "request", "question", "fyi", "feature"])
                    .optional()
                    .describe("Filter on intent of the parent ticket."),
                limit: z.number().int().min(1).max(200).optional().describe("Max hits to return. Default 50, hard cap 200."),
                since: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp. Filters hits whose ticket or comment `created_at` is >= since. Useful for 'what matched X in the last hour'. Date.parse-friendly (e.g. '2026-05-12T13:00:00Z' or '2026-05-12').",
                    ),
            },
        },
        async ({ query, project, open, intent, limit, since }) => {
            const hits = await client.search({
                query,
                project,
                open,
                intent,
                limit,
                since,
            });
            return asText(hits);
        },
    );

    server.registerTool(
        "ticket_neighbors",
        {
            description:
                "What to read before touching a ticket. Returns the tickets it is written about (and that write about it), pulled from ticket references in prose rather than from hand-typed relations — which matters because typed relations capture only a fraction of the links people actually write: measured on this corpus, 152 of 156 typed relations were ALSO stated in prose, while thousands of prose links were never typed. Each neighbour carries `weight` (how many times the pair is named — once is often decoration, twice or more is a real link), `direction`, the neighbour's `stage` (so you see at a glance that a dependency already closed), `foreign_project: true` when it lives in ANOTHER project (the case nothing else surfaces today), `typed_kind` when a typed relation also exists, and a `citation` (`message_id` + `offset`) pointing at the sentence the link was read from — so you can go check instead of trusting. Sorted by weight. Use it before editing a ticket you haven't read in a while, and to find cross-project dependencies that no relation records. This is a READ: it changes nothing.",
            inputSchema: {
                ticket_id: z.number().int().describe("The ticket to look around."),
                min_weight: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Only neighbours named at least this many times. Default 1 (everything); pass 2 to drop passing mentions."),
                limit: z.number().int().min(1).max(200).optional().describe("Max neighbours, highest weight first."),
            },
        },
        async ({ ticket_id, min_weight, limit }) => {
            return asText(await client.graphNeighbors({ ticket_id, min_weight, limit }));
        },
    );

    server.registerTool(
        "graph_audit",
        {
            description:
                "Hygiene report over the ticket corpus, computed from the compiled reference graph. Four kinds of finding: `stale_open` (an open ticket where every ticket it repeatedly names has closed — its cohort finished without it, which no keyword search can express because it is a property of the neighbourhood, not of the text), `orphan_child` (open child under a closed parent), `cross_project_open_pair` (two OPEN tickets in different projects writing about each other with no typed relation — invisible everywhere else), and `root_cause_cluster` (a small knot of open tickets that are all one investigation; deliberately capped, since the unbounded version is a 153-ticket hairball that tells nobody anything).\n\n**Every finding is a CANDIDATE, never a verdict.** This tool closes nothing, proposes nothing and writes nothing — it hands you a `citation` (`message_id` + `offset`) so you can read the sentence and judge. Treat `stale_open` as 'worth checking whether this is still live', not as 'close it'. `scanned` reports how many open tickets were considered, so an empty result reads as clean rather than broken, and `freshness` says whether this call had to recompile.",
            inputSchema: {
                project: z.string().optional().describe("Scope to one project. Default: every project the consumer can see."),
                limit: z.number().int().min(1).max(200).optional().describe("Max findings."),
            },
        },
        async ({ project, limit }) => {
            return asText(await client.graphAudit({ project, limit }));
        },
    );

    server.registerTool(
        "ticket_get",
        {
            description:
                "Get a ticket. **Default: header only** (no body, no comments) + `comment_count` — cheap probe of state. Pass `full: true` for the full thread. **Full mode is paginated** (#396): by default a bare `full:true` returns the **20 most recent** entries (`order:desc`) WITH full bodies + a `pagination` block (`has_more` flags older entries) — so a reflexive full on a huge thread never overflows. Override with `limit` (e.g. `limit:9999` for everything), `offset` (page older), and `order` (`asc` top_down-oldest-first / `desc` bottom_up-newest-first). The raw HTTP API still returns the whole thread (the web UI renders it all). Pass `brief: true` for the **agent-friendly read** (#B.130 + pivot-cut): header + body + the latest `summary_until` snapshot + every comment_added AFTER that snapshot with full bodies. Everything earlier is dropped — the pivot's contract (\"ticket state AFTER this comment\") guarantees those bodies are already captured in the snapshot line. Lifecycle events (closed/resolved/sub-added/etc.) are always kept regardless of position.\n\n**How to use brief efficiently**: read the pivot's `summary_until` line + every comment after it (full bodies). That's the canonical resume point. The response surfaces `pivot_comment_id` so you can see where the cut happened. If the thread has no agent snapshot anywhere (legacy, pure-human), brief falls back to keeping the last `tail` bodies intact (default 1) and collapsing earlier ones — same behaviour as pre-pivot. If you need a body that was dropped, re-fetch with `full: true`.\n\nPass `digest: true` for a bird's-eye scan: header + ordered `digest[]` of every comment's `summary_until` snapshot (most useful across multiple tickets). Optional `digest_limit: N` keeps just the last N snapshots. Lossy by design — no bodies, no human comments without snapshots. Ignored if `brief` is also set.\n\n**Attachments (#283):** full/brief reads include an `attachments[]` array resolving every `/uploads/<sha>.<ext>` image reference in the shown bodies — `{sha, ext, content_type, bytes, ref, uri, local}`. When `local` is true, `uri` is a `file://` path on this host you can open DIRECTLY with the Read tool (no need to hunt for where the upload lives on disk); when false, `uri`/`ref` is an HTTP path to fetch. So to view a pasted screenshot, read `attachments[].uri` rather than searching the filesystem.",
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
                offset: z
                    .number()
                    .int()
                    .nonnegative()
                    .optional()
                    .describe(
                        "#396 — FULL mode only: skip the first N feed entries (comments + lifecycle), for paging through a long thread. Ignored in brief/digest.",
                    ),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(
                        "#396 — FULL mode only: return at most N feed entries. Combine with `order: \"desc\"` to get the N most recent comments WITH full bodies (bounded size on a huge thread, unlike unpaged full). Ignored in brief/digest.",
                    ),
                order: z
                    .enum(["asc", "desc"])
                    .optional()
                    .describe(
                        "#396 — FULL mode only. `asc` = top_down / oldest-first (default, natural order). `desc` = bottom_up / newest-first → `order:\"desc\", limit:N` ships the N latest entries. The response carries a `pagination` block (offset/limit/returned/total/order/has_more) when paging is active. Ignored in brief/digest.",
                    ),
            },
        },
        async ({ ticket_id, full, brief, tail, digest, digest_limit, offset, limit, order }) => {
            // #434: ticket_get (a READ) no longer moves the token-attribution
            // focus — an incidental `ticket_get(#A)` for context mid-turn used to
            // steal the whole turn's tokens from the ticket you're working. Only
            // WRITES (reply/engage/resolve) set the focus now.
            // #396 (david 6zwrk9): a reflexive `full` (no limit) on a big thread
            // overflows the response cap. So bound the AGENT default — full with
            // no explicit limit → the 20 most recent entries (order=desc) + a
            // pagination block (has_more tells there's more; page with offset or
            // pass a big limit for everything). The raw HTTP API keeps
            // full=everything (the web UI renders the whole thread).
            const isPureFull = full === true && brief !== true && digest !== true;
            const DEFAULT_FULL_LIMIT = 20;
            const effLimit = isPureFull && limit === undefined ? DEFAULT_FULL_LIMIT : limit;
            const effOrder = isPureFull && limit === undefined && order === undefined ? "desc" : order;
            const payload = await client.getTicket(ticket_id, {
                summary: full !== true && brief !== true && digest !== true,
                brief: brief === true,
                tail,
                digest: digest === true,
                digest_limit,
                offset,
                limit: effLimit,
                order: effOrder,
            });
            // #749 Phase A — prune-on-consult. Reading a ticket via MCP is
            // an explicit "I am consulting this thread" signal ; mark every
            // unread ping on it as seen so the wake FIFO doesn't keep
            // pointing back here. Mirrors the web UI's dwell-timer ack
            // (#B.191). Best-effort : a mark-read failure must not break
            // the read response — the caller already has the data they
            // asked for.
            //
            // #749 david (post-Phase 1) — bound the ack by `upToId` = the
            // highest message id IN THIS RESPONSE. Events that arrive AFTER
            // the read snapshot (id > upToId) keep their unseen ping so a
            // racing comment lands as a fresh wake instead of being
            // silently flagged as already-consulted.
            const snapshot = payload as {
                ticket?: { id?: number };
                comments?: Array<{ id?: number }>;
            };
            const ids: number[] = [];
            if (typeof snapshot.ticket?.id === "number") ids.push(snapshot.ticket.id);
            if (Array.isArray(snapshot.comments)) {
                for (const c of snapshot.comments) {
                    if (typeof c?.id === "number") ids.push(c.id);
                }
            }
            const upToId = ids.length > 0 ? Math.max(...ids) : undefined;
            try {
                await client.markTicketRead(
                    ticket_id,
                    upToId !== undefined ? { upToId } : undefined,
                );
            } catch { /* best-effort */ }
            return asText(payload);
        },
    );
}
