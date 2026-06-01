/**
 * Inbox / poll MCP tools (carved out of src/mcp.ts in #B.213 phase
 * 4.D on 2026-05-19). Behavior-preserving move.
 *
 * Tools: unread, poll. Each does a lot of plumbing — unread juggles
 * pings vs project-feed × count_only vs mark_all vs mark_read; poll
 * aggregates eight parallel reads into one boot-friendly snapshot.
 *
 * Exposed entry point: `registerInboxTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

export function registerInboxTools(server: McpServer): void {
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

    server.registerTool(
        "arbitrage",
        {
            description:
                "#697 F5 — list the pending plan / resolution decisions on tickets THIS agent reports, waiting for accept / reject. The 'ball in MY court' lens : distinct from `my_pending_tickets` (= your drafts waiting on a human moderator) — `arbitrage` is the inverse, work waiting on YOU. Each entry returns `{comment_id, comment_hashid, ticket_id, ticket_title, ticket_project, decision_kind ('plan'|'resolution'), proposed_by, created_at, summary_until}` so the agent can triage without re-fetching every thread. Sorted most-recent-first.",
            inputSchema: {},
        },
        async () => {
            const r = await client.myArbitrage();
            const decisions = (r as { decisions?: unknown }).decisions ?? [];
            return asText({ kind: "arbitrage", decisions });
        },
    );

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
}
