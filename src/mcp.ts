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

/**
 * Hardened sandbox mode (#B.63). When AIBALL_MCP_MODE=sandbox is set, the
 * server locks `by_agent` on every write to the resolved agent id —
 * preventing an autonomous sub-agent from impersonating the human, another
 * agent, or a fabricated identity. Whatever the agent passes in the param
 * is ignored. Normal mode (unset) keeps the previous behavior where
 * `by_agent` is an optional override.
 */
const SANDBOX_MODE = process.env.AIBALL_MCP_MODE === "sandbox";
function effectiveBy(provided: string | undefined): string {
    if (SANDBOX_MODE) return client.agentId;
    return provided ?? client.agentId;
}

const server = new McpServer({
    name: "aiball",
    version: "0.2.0",
});

/**
 * Lightweight "is anything waiting for me" probe injected into every tool
 * response so the agent always sees, in passing, whether they should call
 * `unread` / `unread({ pings: true })` or check on their own pending
 * tickets. Three cheap GETs (one count each). Failures degrade silently —
 * the tool result is still valid.
 */
async function microStatus(): Promise<{
    unread_project: number;
    unread_pings: number;
    my_pending: number;
    project: string | null;
}> {
    const proj = client.defaultProject;
    const [pjCount, pgCount, mpCount] = await Promise.all([
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
        client
            .myPendingCount()
            .then((r) => r.count ?? 0)
            .catch(() => 0),
    ]);
    return {
        unread_project: pjCount,
        unread_pings: pgCount,
        my_pending: mpCount,
        project: proj,
    };
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
            "Create a new ticket in a project. Falls back to the file spool if the daemon is down. Pass `broadcast: true` to create the ticket already flagged as broadcast (project followers receive pings); default is internal-only (project owners + explicit ticket subscribers).",
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe(
                    "Project name (free-form). Defaults to $AIBALL_PROJECT if set.",
                ),
            title: z.string().describe("Ticket title"),
            summary: z
                .string()
                .optional()
                .describe(
                    "Optional one-sentence summary (#B.87). Shown in inbox lists, ping notifications, search snippets. If omitted, consumers fall back to `title`. Try to write something tighter than the title — 5-15 words capturing the actionable gist.",
                ),
            body: z.string().optional().describe("Ticket body / description"),
            intent: z
                .enum(["panic", "request", "question", "fyi"])
                .optional()
                .describe(
                    "panic = immediate blocker; question = needs an answer; request = action expected (default intent); fyi = informational, no action expected.",
                ),
            broadcast: z
                .boolean()
                .optional()
                .describe(
                    "If true, the ticket is broadcast at creation: project followers (subscriptions.role=follower) get pings on it, in addition to project owners and explicit ticket subscribers. Default false (internal-only).",
                ),
            by_agent: z
                .string()
                .optional()
                .describe("Author identity. Defaults to the resolved agent id."),
            parent_id: z
                .number()
                .int()
                .optional()
                .describe(
                    "Optional parent ticket id (sub-ticket). When set, the new ticket is a child of the named ticket — useful to split a large request (a multi-item CR) into actionable children while keeping the lineage explicit. The parent's thread surfaces a list of its sub-tickets in the UI.",
                ),
            tags: z
                .array(z.string())
                .optional()
                .describe(
                    "Optional tag names to apply to the new ticket. Resolved server-side (case-sensitive match on name). Unknown tag names fail the request — pre-create the tag via the tags settings panel first.",
                ),
        },
    },
    async ({ project, title, summary, body, intent, broadcast, by_agent, parent_id, tags }) => {
        const proj = client.resolveProject(project);
        const res = (await client.postMessage({
            project: proj,
            kind: "ticket_created",
            title,
            summary,
            body,
            intent,
            by_agent: effectiveBy(by_agent),
            parent_id,
        })) as { id?: number };
        if (broadcast === true && typeof res?.id === "number") {
            await client.setTicketBroadcast(res.id, true);
        }
        if (tags && tags.length > 0 && typeof res?.id === "number") {
            // PUT /api/messages/:id/tags accepts tag NAMES alongside ids
            // — it resolves via getTagByName server-side. Unknown names
            // bubble up as 400; let the error propagate to the agent so
            // it knows the tag was wrong rather than silently swallow.
            await client.setMessageTags(res.id, tags);
        }
        // « Nobody is listening » hint (per #B.215): show the agent how
        // many owners / followers exist on the target project, and flag
        // freshly-created projects (= this post is the only thing on it).
        // Failure to fetch stats is silent — the post itself succeeded.
        interface ProjectStatsLite {
            owners: number;
            followers: number;
            ticket_count: number;
            comment_count: number;
        }
        let stats: ProjectStatsLite | null = null;
        try {
            stats = (await client.projectStats(proj)) as ProjectStatsLite;
        } catch {
            stats = null;
        }
        const decorated: Record<string, unknown> = { ...res };
        if (broadcast === true) decorated.broadcast = 1;
        if (stats) {
            decorated.target_project = {
                name: proj,
                owners: stats.owners,
                followers: stats.followers,
                is_new_project: stats.ticket_count <= 1 && stats.comment_count === 0,
            };
        }
        return asText(decorated);
    },
);

// `ticket_broadcast` and `ticket_postpone` were merged into `ticket_update`
// per #B.76 — they were both setters on persistent ticket fields, so
// they naturally fold into a single patch-style tool (along with the
// edit verb that was on the MCP roadmap). The dedicated tools are
// removed; surface stays at 12.

server.registerTool(
    "ticket_reply",
    {
        description:
            "Post a reply within a ticket thread. `target_id` is either a ticket id (→ top-level comment on the ticket) or a comment id (→ nested reply to that specific comment, Gmail-style). Both produce a comment_added; only parent_id differs.\n\n**`summary_until` is required** (#B.130) — pass a one-line TLDR of the thread state *up to AND including this comment*. Not just this comment's body in isolation; a rolling summary that future brief-mode reads can use to skip full bodies. The API rejects comment_added without it (HTTP 400).\n\nOptional `then` lets the author tag the comment with a decision intent or chain a unilateral state mutation, in the same call:\n- `then: \"resolved\"` — tag the comment as a *resolution decision* (#B.129). The comment carries `meta.decision={kind:\"resolution\",status:\"pending\"}` and the reporter validates it via accept/reject. Closing the ticket auto-accepts any dangling resolution decisions. The 'decision-on-comment' paradigm: the audit lives in the thread, no separate lifecycle row.\n- `then: \"close\"` — close the ticket. Owner-bypass when posted by the reporter.\n- `then: \"reopen\"` — reopen a closed ticket (resets resolved too).\n\nUse `then: \"resolved\"` instead of separate reply + ticket_close when finishing work on someone else's ticket: a single call posts the explanation comment AND tags it as a pending resolution proposal. The reporter sees ONE accept/reject pair under the composer.\n\nIf you need more info before you can proceed, just post a plain comment with your question — there is no agent→human \"blocked\" signal anymore (it induced misuse where agents temporized with blocked instead of asking; the conversational comment IS the right primitive).",
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
            summary_until: z
                .string()
                .min(1)
                .describe(
                    "One-line TLDR of the thread state *up to AND including this comment* (#B.130). Required for agent authors — the API rejects comment_added without it (HTTP 400). Humans skip the requirement. Each summary_until supersedes the previous: only the most recent one is shown as the canonical 'current state' banner. Soft cap 200 chars.",
                ),
            then: z
                .enum(["resolved", "close", "reopen"])
                .optional()
                .describe(
                    "Optional intent on the comment. `resolved` (#B.129) = tag the comment as a resolution decision (`meta.decision={kind:\"resolution\",status:\"pending\"}`); the reporter accept/reject — no separate ticket_resolved row anymore, the comment IS the proposal and the audit lives on it. `close` = close the ticket (reporter-only). `reopen` = bring a closed ticket back. `close`/`reopen` are still emitted as distinct lifecycle event rows; `resolved` is a comment+decision sidecar. There is no agent→human `blocked` option — post a plain comment with your question if you need info before proceeding.",
                ),
        },
    },
    async ({ target_id, body, project, by_agent, summary_until, then }) => {
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
        // A state change is just a decorator on a comment. Two shapes:
        //
        //   - close / reopen → dedicated kind row (unilateral state
        //     mutation).
        //   - resolved → since #B.129, posts a `comment_added` with
        //     `decision_kind="resolution"` instead of the legacy
        //     `ticket_resolved` row. The reporter validates via the
        //     decide endpoint, same as any other decisional comment.
        //     Historical `ticket_resolved` rows stay readable in the
        //     lifecycle replay — replays accept both shapes.
        //
        // `blocked` was retired from the `then` enum (#B.129 wording
        // pass): the primitive induced misuse (agents temporizing
        // with blocked when they were just waiting on input). The
        // right pattern for "I need info" is a plain comment with a
        // question — the conversational thread covers it naturally.
        const kind: string = !then
            ? "comment_added"
            : then === "resolved"
              ? "comment_added"
              : then === "close"
                ? "ticket_closed"
                : "ticket_reopened";
        const decision_kind = then === "resolved" ? "resolution" : undefined;
        const proj = project ?? target.project;
        const res = await client.postMessage({
            project: proj,
            kind,
            ticket_id: ticketId,
            parent_id: parentId,
            body,
            by_agent: effectiveBy(by_agent),
            decision_kind,
            // Only forward summary_until for comment_added kinds —
            // close/reopen are lifecycle rows where the field has no
            // meaning and the validator would reject it.
            summary_until: kind === "comment_added" ? summary_until : undefined,
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
            by_agent: effectiveBy(by_agent),
        });
        return asText(res);
    },
);

/**
 * Snooze a ticket until a future timestamp (per #B.329). Accepts either
 * an absolute ISO8601 date OR a relative shorthand:
 *   "+30m" / "+2h" / "+3d" / "+1w" / "+1mo" (mo = ~30 days for simplicity).
 * The ticket is hidden from the open inbox until the deadline. At that
 * point, the daemon's reveal cron pops it back in.
 */
function resolveUntil(input: string): string {
    const m = /^\+(\d+)(min|m|h|d|w|mo)$/.exec(input.trim());
    if (m) {
        const n = Number(m[1]);
        const unit = m[2];
        const ms = (() => {
            switch (unit) {
                case "min":
                case "m": return n * 60_000;
                case "h": return n * 3_600_000;
                case "d": return n * 86_400_000;
                case "w": return n * 7 * 86_400_000;
                case "mo": return n * 30 * 86_400_000;
                default: return 0;
            }
        })();
        if (ms <= 0) throw new Error(`invalid relative until "${input}"`);
        return new Date(Date.now() + ms).toISOString();
    }
    const ts = Date.parse(input);
    if (!Number.isFinite(ts)) throw new Error(`invalid until "${input}" — expected ISO8601 or +<N><unit>`);
    if (ts <= Date.now()) throw new Error(`until must be in the future`);
    return new Date(ts).toISOString();
}

/**
 * Patch a ticket's persistent fields (per #B.76). Replaces the dedicated
 * `ticket_postpone`, `ticket_broadcast`, and the planned `ticket_edit`
 * tools — they were all setters on the same row, so one patch verb is
 * the natural shape.
 *
 * Each field has its own permission check enforced by the daemon:
 *  - title / body / intent → owner-bypass (author only) or human.
 *  - broadcast             → owner-bypass.
 *  - postponed_until       → reporter or human.
 *
 * Pass `null` to clear a value (e.g. `postponed_until: null` un-snoozes;
 * `title: null` would normally be invalid since a ticket needs a title,
 * so the daemon rejects that one).
 *
 * Multiple fields can be patched in one call. Each maps to its own
 * existing HTTP endpoint under the hood (edit / postpone / broadcast),
 * so this is a thin orchestrator MCP-side.
 */
server.registerTool(
    "ticket_update",
    {
        description:
            "Patch a ticket's persistent fields in one call. Pass only the fields you want to change. Each field has its own permission check enforced by the daemon — owner-bypass for edit (title/body/intent) and broadcast, reporter-or-human for snooze.\n\n`postponed_until` accepts either an ISO8601 timestamp (e.g. `2026-05-18T09:00:00Z`) or a relative shorthand (`+30m`, `+2h`, `+3d`, `+1w`, `+1mo`). Pass `null` to clear (un-snooze). Other clearable fields (`body`, `intent`) accept `null` the same way; `title` must remain non-empty.",
        inputSchema: {
            ticket_id: z
                .number()
                .int()
                .describe("Ticket id (the integer in #B.<id>)."),
            title: z
                .string()
                .nullable()
                .optional()
                .describe("New title (owner-bypass). Omit to leave unchanged."),
            summary: z
                .string()
                .nullable()
                .optional()
                .describe(
                    "New one-line summary (#B.87, owner-bypass). Pass null to clear and fall back to title.",
                ),
            body: z
                .string()
                .nullable()
                .optional()
                .describe("New body (owner-bypass). Pass null to clear."),
            intent: z
                .enum(["panic", "request", "question", "fyi"])
                .nullable()
                .optional()
                .describe("New intent label (owner-bypass)."),
            broadcast: z
                .boolean()
                .optional()
                .describe(
                    "Flip broadcast flag (owner-bypass). true = project followers receive pings; false = internal-only.",
                ),
            postponed_until: z
                .string()
                .nullable()
                .optional()
                .describe(
                    "Snooze the ticket until this deadline. ISO8601 or relative shorthand (+30m / +2h / +3d / +1w / +1mo). Pass null (or empty string) to un-snooze. Reporter-or-human only.",
                ),
        },
    },
    async ({ ticket_id, title, summary, body, intent, broadcast, postponed_until }) => {
        const results: Record<string, unknown> = { ticket_id };
        // Each field maps to its own HTTP endpoint. Apply in this
        // order: edit fields first (they may change the title/body the
        // following flips display), then broadcast, then postpone.
        if (
            title !== undefined ||
            body !== undefined ||
            summary !== undefined ||
            intent !== undefined
        ) {
            results.edit = await client.edit(ticket_id, { title, summary, body, intent });
        }
        if (broadcast !== undefined) {
            results.broadcast = await client.setTicketBroadcast(ticket_id, broadcast);
        }
        if (postponed_until !== undefined) {
            if (postponed_until === null || !postponed_until.trim()) {
                results.postponed_until = await client.unsnoozeTicket(ticket_id);
            } else {
                const iso = resolveUntil(postponed_until);
                results.postponed_until = await client.postponeTicket(ticket_id, iso);
            }
        }
        if (Object.keys(results).length === 1) {
            throw new Error("ticket_update needs at least one field — pass title/body/intent/broadcast/postponed_until");
        }
        return asText(results);
    },
);

/**
 * Moderate a pending post — approve or reject it. Replaces the
 * previous workaround of curl'ing /api/messages/:id/approve directly.
 * target_id is the internal numeric id; for comments, use the id
 * returned by ticket_reply (not the user-visible hashid).
 *
 * Human-only by convention (the rule engine + agent rules are what
 * normally handles moderation; this is the manual override).
 */
server.registerTool(
    "ticket_decide",
    {
        description:
            "Approve or reject a pending post (ticket or comment). target_id is the internal numeric id of the message — for a ticket, the integer id; for a comment, the id field returned by ticket_reply. Rejecting silently removes the row from inboxes; approving runs the normal fan-out (pings, broadcast, downstream actions). Human-only by convention — manual override for the rule engine.",
        inputSchema: {
            target_id: z
                .number()
                .int()
                .describe("Internal numeric id of the message to decide."),
            decision: z
                .enum(["approve", "reject"])
                .describe("approve = mark as approved (fan-out runs); reject = mark as rejected (pings wiped)."),
        },
    },
    async ({ target_id, decision }) => {
        const res = decision === "approve"
            ? await client.approve(target_id)
            : await client.reject(target_id);
        return asText(res);
    },
);

server.registerTool(
    "ticket_list",
    {
        description:
            "List tickets, optionally filtered by project, tags, author, status, title substring, or `since` (created_at >= ISO8601). Snoozed tickets excluded by default when `open: true` — pass `include_snoozed: true` to surface them. Tag filter is AND-semantic. **Default: header-only rows** (id, title, summary, status, parent, sub_count, tags) — no bodies. Pass `full: true` to include `body` per row. Use ticket_get for one full thread.",
        inputSchema: {
            project: z.string().optional(),
            open: z
                .boolean()
                .optional()
                .describe("If true, only tickets that have not been closed."),
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
            "Full-text search over ticket titles, ticket bodies, and comment / lifecycle bodies. Backed by SQLite FTS5: case-insensitive, accent-insensitive, whitespace-separated tokens are AND-ed (so `search('hashid broadcast')` finds rows containing both). Returns at most `limit` hits sorted by FTS5 relevance (more relevant first). Each hit carries a `snippet` with `<mark>…</mark>` around the match, plus enough context (project, by_agent, created_at, kind=ticket|comment, hashid for comments) to render without an extra round-trip. Snoozed parent tickets are filtered out by default — pass `include_snoozed: true` to surface their hits. Use this instead of scrolling `ticket_list` when you remember a keyword but not a number.",
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
            "Get a ticket. **Default: header only** (no body, no comments) + `comment_count` — cheap probe of state. Pass `full: true` for the full thread (header with body + all approved comments). Pass `brief: true` for a token-efficient middle ground (#B.130): header + body + comments with `summary_until` (the one-line TLDR each comment carries in `meta.summary_until`) instead of full bodies. The LAST comment keeps its full body so you see the current state. Comments without a summary surface as `summary_until: null` — fetch full if you need that one body. Best practice when authoring: always pass `summary_until` on `ticket_reply` so future brief-mode reads stay useful.",
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
                    "If true (and `full` is true OR brief implies full), return the full thread but with each comment_added body replaced by its `summary_until` (one-line TLDR from meta.summary_until). The LAST comment keeps its full body. Comments without a meta.summary_until surface as `summary_until: null`. Use this to scan long threads cheaply — ~5x token reduction on threads with disciplined summaries.",
                ),
        },
    },
    async ({ ticket_id, full, brief }) => {
        return asText(
            await client.getTicket(ticket_id, {
                summary: full !== true && brief !== true,
                brief: brief === true,
            }),
        );
    },
);

// ---- subscriptions (project + ticket) -------------------------------------

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

// ---- inbox (project feed + personal pings, plus optional ack) -------------

server.registerTool(
    "unread",
    {
        description:
            "Pull approved messages this agent hasn't seen yet. Default mode is the project feed (set with project, or $AIBALL_PROJECT). Pass pings=true to read personal pings (lineage-based notifications across every ticket you participated in or explicitly follow). Set mark_read=true to ack in the same call — only the messages returned in this very response are acked, never anything the agent didn't see. Pass count_only=true to just receive the unread count without any payload. Pass mark_all=true to ack EVERYTHING (no slice returned, just the count of what was acked) — useful for cleanup. peek=true forces read-only inspection (overrides both mark_read and mark_all). Self-pings are filtered out.",
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
                    "Read-only inspection. Forces no state mutation regardless of mark_read / mark_all. Useful for dry runs, scripts that snapshot state, or debugging the inbox.",
                ),
            count_only: z
                .boolean()
                .optional()
                .describe(
                    "If true, skip the payload and return just the unread count. Lightest call for 'do I have anything ?'.",
                ),
            mark_all: z
                .boolean()
                .optional()
                .describe(
                    "If true, ack EVERYTHING currently unread without sending the payload back. Returns { marked_all: true, count: N }. Suppressed when peek=true.",
                ),
        },
    },
    async ({ project, pings, limit, mark_read, peek, count_only, mark_all }) => {
        const isPeek = peek === true;
        const shouldAck = mark_read === true && !isPeek;
        const wantCountOnly = count_only === true;
        const wantMarkAll = mark_all === true && !isPeek;

        if (pings === true) {
            if (wantCountOnly && !wantMarkAll) {
                const r = (await client.pingsCount()) as { unread?: number };
                return asText({ kind: "pings", count: r.unread ?? 0 });
            }
            if (wantMarkAll) {
                const before = (await client.pingsCount()) as { unread?: number };
                await client.markPingsRead({ all: true });
                return asText({
                    kind: "pings",
                    marked_all: true,
                    count: before.unread ?? 0,
                });
            }
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
            return asText({ kind: "pings", peek: isPeek, ...((data as object) ?? {}) });
        }

        const proj = client.resolveProject(project);
        if (wantCountOnly && !wantMarkAll) {
            const r = (await client.unreadCount(proj)) as { count?: number };
            return asText({ kind: "project", project: proj, count: r.count ?? 0 });
        }
        if (wantMarkAll) {
            // Walk through the entire unread set in pages and ack each id.
            // mark_read on the project feed is per-message, no bulk endpoint
            // exists. Loop until empty.
            let total = 0;
            while (true) {
                const page = (await client.unread(proj, 500)) as
                    | { messages?: Array<{ id: number }> }
                    | undefined;
                const msgs = page?.messages ?? [];
                if (msgs.length === 0) break;
                for (const m of msgs) {
                    await client.markMessageSeen(m.id);
                    total++;
                }
            }
            return asText({
                kind: "project",
                project: proj,
                marked_all: true,
                count: total,
            });
        }
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
        return asText({ kind: "project", peek: isPeek, ...((data as object) ?? {}) });
    },
);

// ---- poll: agent context + what's waiting --------------------------------

server.registerTool(
    "poll",
    {
        description:
            "Snapshot of the agent's context AND what's waiting for them. Call this on session boot AND any time you want to see if anything new requires attention. Default scope is slim AND project-scoped when AIBALL_PROJECT is set (only the relevant project's counters and pending lists are returned). Pass `all_projects: true` for the cross-project view. My_pending_tickets / my_pending_comments are returned in summary mode (header only, no body) by default — pass `full_pending: true` if you need bodies.\n\nProactive flow expectation: if the response shows `unread_pings > 0` or `unread_project > 0`, call `unread({pings: true, mark_read: true})` (or `unread({mark_read: true})` for the project feed) yourself — do NOT ask the human first. The human IS watching this via the web UI; you're expected to drain, read, react, and only escalate when you have a concrete question or blocker. Stopping at 'should I check the pings?' wastes a round-trip.",
        inputSchema: {
            include_subscriptions: z
                .boolean()
                .optional()
                .describe(
                    "If true, include `project_subscriptions[]` and `ticket_subscriptions[]` (the full subscription lists). Default false — they're hidden because most pollers don't need them.",
                ),
            include_projects: z
                .boolean()
                .optional()
                .describe(
                    "If true, include `known_projects[]` (the bare list of project names). Default false — the open_tickets map already encodes the project set.",
                ),
            include_snoozed: z
                .boolean()
                .optional()
                .describe(
                    "If true, snoozed tickets count toward the bookends (first/last). Default false — snoozed tickets are explicitly set aside, they shouldn't surface at the edges of a 'what's active' view.",
                ),
            all_projects: z
                .boolean()
                .optional()
                .describe(
                    "If true, return cross-project bookends + counters + pending lists. When unset and AIBALL_PROJECT is exported, the response is scoped to that project only (less noise for single-project sessions).",
                ),
            full_pending: z
                .boolean()
                .optional()
                .describe(
                    "If true, include bodies in my_pending_tickets / my_pending_comments. Default false — summary rows only (id, title, status, intent, …) to save tokens.",
                ),
        },
    },
    async ({
        include_subscriptions,
        include_projects,
        include_snoozed,
        all_projects,
        full_pending,
    }) => {
        const wantSubs = include_subscriptions === true;
        const wantProjects = include_projects === true;
        const wantSnoozed = include_snoozed === true;
        const allProjects = all_projects === true;
        const scopeProject =
            !allProjects && client.defaultProject ? client.defaultProject : null;
        const summaryPending = full_pending !== true;
        const [
            daemon,
            projectSubs,
            ticketSubs,
            projectStats,
            myPending,
            myPendingComments,
            pingCount,
            bookends,
        ] = await Promise.all([
            client.health().then(
                (info) => ({ up: true as const, ...((info as object) ?? {}) }),
                (e) => ({ up: false as const, error: (e as Error).message }),
            ),
            wantSubs ? client.mySubs().catch(() => []) : Promise.resolve(null),
            wantSubs
                ? client.myTicketSubs().catch(() => ({ subscriptions: [] }))
                : Promise.resolve(null),
            client.listProjectsDetailed().catch(() => []),
            client.myPendingTickets().catch(() => []),
            client.myPendingComments().catch(() => []),
            client.pingsCount().catch(() => ({ unread: 0 })),
            client
                .bookends({
                    includeSnoozed: wantSnoozed,
                    project: scopeProject ?? undefined,
                })
                .catch(() => ({ first: null, last: null })),
        ]);
        const rawStats = Array.isArray(projectStats) ? projectStats : [];
        const stats = scopeProject
            ? rawStats.filter((p) => p.name === scopeProject)
            : rawStats;
        const openTickets: Record<string, number> = {};
        const snoozedTickets: Record<string, number> = {};
        let openTicketsTotal = 0;
        let snoozedTicketsTotal = 0;
        for (const p of stats) {
            const n = typeof p.open_count === "number" ? p.open_count : 0;
            const s = typeof p.snoozed_count === "number" ? p.snoozed_count : 0;
            openTickets[p.name] = n;
            snoozedTickets[p.name] = s;
            openTicketsTotal += n;
            snoozedTicketsTotal += s;
        }
        // Project-scope my_pending_* if AIBALL_PROJECT is set and we're
        // not in all_projects mode. Default summary projection drops the
        // body / edited_body to keep poll() responses small.
        const projectionPending = (rows: unknown): unknown => {
            const arr = Array.isArray(rows) ? rows : [];
            const scoped = scopeProject
                ? arr.filter(
                      (m) => (m as { project?: string }).project === scopeProject,
                  )
                : arr;
            if (!summaryPending) return scoped;
            return scoped.map((m) => {
                const r = m as Record<string, unknown>;
                const { body: _b, edited_body: _eb, ...rest } = r;
                void _b; void _eb;
                return rest;
            });
        };
        const myPendingOut = projectionPending(myPending);
        const myPendingCommentsOut = projectionPending(myPendingComments);
        // Build the response object — fields are conditionally included
        // based on the opt-in flags. Slim by default per #B.68 user spec.
        const out: Record<string, unknown> = {
            consumer_id: client.agentId,
            // The MCP server process cwd, which is used as the fallback to
            // derive the consumer_id when AIBALL_AGENT is unset. Renamed
            // from `cwd` (per #B.215 feedback) — the bare name read as
            // "the client's cwd" while it is actually the server's.
            mcp_server_cwd: process.cwd(),
            source: process.env.AIBALL_AGENT ? "AIBALL_AGENT env" : "sha256(mcp_server_cwd)",
            default_project: client.defaultProject,
            scope: scopeProject ?? "all_projects",
            daemon,
            /** Per-project count of approved, currently-open tickets
             *  (i.e. not closed, not rejected, not snoozed). */
            open_tickets: openTickets,
            open_tickets_total: openTicketsTotal,
            /** Per-project count of tickets currently snoozed
             *  (postponed_until > now). Hidden from `open_tickets`.
             *  Use `ticket_list({include_snoozed: true})` to retrieve. */
            snoozed_tickets: snoozedTickets,
            snoozed_tickets_total: snoozedTicketsTotal,
            /** Bookend tickets in scope — first (oldest) and last
             *  (most recent). Cross-project, ordered by id. Snoozed
             *  tickets are excluded unless `include_snoozed=true`. */
            first_ticket: (bookends as { first?: unknown }).first ?? null,
            last_ticket: (bookends as { last?: unknown }).last ?? null,
            my_pending_tickets: myPendingOut,
            /** Pending comments authored by this agent (#B.69). Needed
             *  even in `auto-reply` since the strategy can flip to
             *  `manual` at any moment — comments stuck in moderation
             *  should always be visible to their author. */
            my_pending_comments: myPendingCommentsOut,
            unread_pings: (pingCount as { unread?: number }).unread ?? 0,
        };
        if (wantSubs) {
            out.project_subscriptions = projectSubs;
            out.ticket_subscriptions =
                (ticketSubs as { subscriptions?: unknown[] } | null)?.subscriptions ?? ticketSubs;
        }
        if (wantProjects) {
            out.known_projects = stats.map((p) => p.name);
        }
        return asText(out);
    },
);

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
