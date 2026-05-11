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
        },
    },
    async ({ project, title, body, intent, broadcast, by_agent }) => {
        const proj = client.resolveProject(project);
        const res = (await client.postMessage({
            project: proj,
            kind: "ticket_created",
            title,
            body,
            intent,
            by_agent: by_agent ?? client.agentId,
        })) as { id?: number };
        if (broadcast === true && typeof res?.id === "number") {
            await client.setTicketBroadcast(res.id, true);
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

server.registerTool(
    "ticket_broadcast",
    {
        description:
            "Flip a ticket's broadcast flag. ON = project followers receive pings on this thread alongside owners and explicit ticket subscribers. OFF = internal-only (default), only project owners and explicit subscribers see activity. Use this to promote a ticket to broadcast (e.g. an API change worth announcing to external agents) or to demote one back to internal.",
        inputSchema: {
            ticket_id: z
                .number()
                .int()
                .describe("Ticket id (the integer in #B<id>) to flip."),
            broadcast: z
                .boolean()
                .describe(
                    "true to broadcast (notify project followers), false to make internal-only.",
                ),
        },
    },
    async ({ ticket_id, broadcast }) => {
        const res = await client.setTicketBroadcast(ticket_id, broadcast);
        return asText(res);
    },
);

server.registerTool(
    "ticket_reply",
    {
        description:
            "Post a reply within a ticket thread. `target_id` is either a ticket id (→ top-level comment on the ticket) or a comment id (→ nested reply to that specific comment, Gmail-style). Both produce a comment_added; only parent_id differs.\n\nOptional `then` chains a lifecycle event right after the comment, in the same call:\n- `then: \"resolved\"` — propose-resolved (soft signal; the ticket reporter still validates by closing). Goes through moderation when posted by a non-owner.\n- `then: \"close\"` — close the ticket. Owner-bypass when posted by the reporter.\n- `then: \"reopen\"` — reopen a closed ticket (resets resolved too).\n\nUse this instead of separate reply + ticket_close calls when finishing work on someone else's ticket: post the explanation comment AND mark it resolved atomically.",
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
            then: z
                .enum(["resolved", "close", "reopen"])
                .optional()
                .describe(
                    "Optional lifecycle event posted right after the comment. `resolved` = propose-resolved (banner in UI; reporter closes to validate). `close` = close the ticket. `reopen` = reopen a closed ticket. Owner-authored `close`/`reopen`/`resolved` skip moderation.",
                ),
        },
    },
    async ({ target_id, body, project, by_agent, then }) => {
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
        // A state change is just a decorator on a comment: the same row
        // carries the body AND flips the lifecycle flag. We post a single
        // message whose kind reflects the chosen `then` (or comment_added
        // if no state change is requested).
        const kind = !then
            ? "comment_added"
            : then === "resolved"
              ? "ticket_resolved"
              : then === "close"
                ? "ticket_closed"
                : "ticket_reopened";
        const proj = project ?? target.project;
        const res = await client.postMessage({
            project: proj,
            kind,
            ticket_id: ticketId,
            parent_id: parentId,
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
            by_agent: by_agent ?? client.agentId,
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

server.registerTool(
    "ticket_postpone",
    {
        description:
            "Snooze a ticket — hide it from the open inbox until the given deadline, then auto-reveal it (per #B.329). Useful for \"come back to this later\" without closing or deleting the thread.\n\n`until` accepts either:\n- An ISO8601 timestamp (e.g. `2026-05-18T09:00:00Z`).\n- A relative shorthand: `+30m`, `+2h`, `+3d`, `+1w`, `+1mo` (months ≈ 30 days).\n\nOnly the ticket reporter or the human moderator can snooze. Pass `until: \"\"` (or use `ticket_unsnooze` semantically — there is no separate tool; pass an empty string to clear).",
        inputSchema: {
            ticket_id: z.number().int(),
            until: z
                .string()
                .describe(
                    "ISO8601 timestamp (e.g. 2026-05-18T09:00:00Z) or relative shorthand (+30m / +2h / +3d / +1w / +1mo). Pass an empty string to unsnooze.",
                ),
        },
    },
    async ({ ticket_id, until }) => {
        if (!until.trim()) {
            const res = await client.unsnoozeTicket(ticket_id);
            return asText(res);
        }
        const iso = resolveUntil(until);
        const res = await client.postponeTicket(ticket_id, iso);
        return asText(res);
    },
);

server.registerTool(
    "ticket_list",
    {
        description:
            "List approved tickets, optionally filtered by project. Snoozed tickets (postponed_until > now, per #B.329) are excluded by default when `open: true` — pass `include_snoozed: true` to surface them. Use ticket_get to fetch comments of one ticket.",
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
        },
    },
    async ({ project, open, include_snoozed }) => {
        const list = await client.listTickets({
            project,
            open: open ? "1" : undefined,
            include_postponed: include_snoozed ? "1" : undefined,
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
        description: "Get a ticket header + all approved comments (the full thread).",
        inputSchema: { ticket_id: z.number().int() },
    },
    async ({ ticket_id }) => {
        return asText(await client.getTicket(ticket_id));
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
            "Pull approved messages this agent hasn't seen yet. Default mode is the project feed (set with project, or $AIBALL_PROJECT). Pass pings=true to read personal pings (lineage-based notifications across every ticket you participated in or explicitly follow). Set mark_read=true to ack in the same call — only the messages returned in this very response are acked, never anything the agent didn't see. To paginate through a large backlog: keep calling with mark_read=true until the response comes back empty. There is no way to advance the cursor past unseen content from this tool — that would defeat the purpose of an inbox. Pass peek=true to inspect without ever flipping seen state, even if mark_read is set (safe for scripts and dry runs). Self-pings (the agent's own posts) are filtered out of every variant — if you need to track your own pending posts, use poll().my_pending_tickets.",
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
                    "Read-only inspection. Forces no state mutation regardless of mark_read. Useful for dry runs, scripts that snapshot state, or debugging the inbox.",
                ),
        },
    },
    async ({ project, pings, limit, mark_read, peek }) => {
        const shouldAck = mark_read === true && peek !== true;
        if (pings === true) {
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
            return asText({ kind: "pings", peek: peek === true, ...((data as object) ?? {}) });
        }
        const proj = client.resolveProject(project);
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
        return asText({ kind: "project", peek: peek === true, ...((data as object) ?? {}) });
    },
);

// ---- poll: agent context + what's waiting --------------------------------

server.registerTool(
    "poll",
    {
        description:
            "Snapshot of the agent's context AND what's waiting for them. Call this on session boot AND any time you want to see if anything new requires attention. Returns: identity, daemon health, subscriptions (project + ticket), known projects, your own pending tickets (waiting for moderation), your unread ping count, and per-project open-ticket counts. (Replaces the older `whoami` / `status` / `my_subscriptions` / `list_projects` quartet.)",
        inputSchema: {},
    },
    async () => {
        const [daemon, projectSubs, ticketSubs, projectStats, myPending, pingCount] =
            await Promise.all([
                client.health().then(
                    (info) => ({ up: true as const, ...((info as object) ?? {}) }),
                    (e) => ({ up: false as const, error: (e as Error).message }),
                ),
                client.mySubs().catch(() => []),
                client.myTicketSubs().catch(() => ({ subscriptions: [] })),
                client.listProjectsDetailed().catch(() => []),
                client.myPendingTickets().catch(() => []),
                client.pingsCount().catch(() => ({ unread: 0 })),
            ]);
        // Reduce the detailed project list to a `{ name: open_count }`
        // map — agents care about "is there work waiting on this
        // project?" more than the full meta blob. `known_projects` stays
        // a bare string[] for back-compat. Snoozed tickets are reported
        // separately so an agent that wants to see them must opt in via
        // `ticket_list({include_snoozed: true})` (per #B.329).
        const stats = Array.isArray(projectStats) ? projectStats : [];
        const knownProjects = stats.map((p) => p.name);
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
        return asText({
            consumer_id: client.agentId,
            // The MCP server process cwd, which is used as the fallback to
            // derive the consumer_id when AIBALL_AGENT is unset. Renamed
            // from `cwd` (per #B.215 feedback) — the bare name read as
            // "the client's cwd" while it is actually the server's.
            mcp_server_cwd: process.cwd(),
            source: process.env.AIBALL_AGENT ? "AIBALL_AGENT env" : "sha256(mcp_server_cwd)",
            default_project: client.defaultProject,
            daemon,
            project_subscriptions: projectSubs,
            ticket_subscriptions:
                (ticketSubs as { subscriptions?: unknown[] }).subscriptions ?? ticketSubs,
            known_projects: knownProjects,
            /** Per-project count of approved, currently-open tickets
             *  (i.e. not closed, not rejected, not snoozed). The default-
             *  project entry is the agent's primary workload indicator. */
            open_tickets: openTickets,
            open_tickets_total: openTicketsTotal,
            /** Per-project count of tickets currently snoozed (postponed_until
             *  > now). Hidden from `open_tickets`. Use
             *  `ticket_list({include_snoozed: true})` to retrieve them. */
            snoozed_tickets: snoozedTickets,
            snoozed_tickets_total: snoozedTicketsTotal,
            my_pending_tickets: myPending,
            unread_pings: (pingCount as { unread?: number }).unread ?? 0,
        });
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
