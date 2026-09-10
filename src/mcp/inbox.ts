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
import { asLines, asText, client } from "./_helpers.js";
import { ARBITRAGE_DEFAULT_LIMIT, renderArbitrage } from "./arbitrage-lines.js";

export function registerInboxTools(server: McpServer): void {
    server.registerTool(
        "unread",
        {
            description:
                "Read-only listing of approved messages this agent hasn't seen yet (#826 david `74x46c`). Default mode is the consumer FIFO — CROSS-PROJECT (a legit fan-out from a ticket in another project lands here too, #800). Pass an explicit `project` to narrow to that project's feed only. Pass `pings=true` for personal pings (lineage-based notifications). Pass `count_only=true` for just the unread count. Self-pings filtered out.\n\n**The agent CANNOT ack messages from MCP anymore** (#826) — the previous `mark_read`/`mark_all`/`peek` flags were removed because draining-without-acting was a footgun (agent saw events, marked them seen, never acted → events lost). Seen-tracking is now exclusively driven by the wake injection (head-FIFO auto-ack at inject time, #749 `fd8f8d6`) and the web UI (humans clicking through). Read this tool for visibility ; act on the wake / explicit ticket reads to clear the queue.",
            inputSchema: {
                project: z.string().optional(),
                pings: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, return personal pings instead of the project feed. Project arg is ignored.",
                    ),
                limit: z.number().int().min(1).max(500).optional(),
                count_only: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, skip the payload and return just the unread count. Lightest call for 'do I have anything ?'.",
                    ),
                since: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp. Filters the project feed to messages whose `created_at` is >= since. Useful for 'show me what landed in the last hour' without touching seen_at. Date.parse-friendly. Ignored when `pings: true` or `count_only: true`.",
                    ),
            },
        },
        async ({ project, pings, limit, count_only, since }) => {
            const wantCountOnly = count_only === true;

            if (pings === true) {
                if (wantCountOnly) {
                    const r = (await client.pingsCount()) as { unread?: number };
                    return asText({ kind: "pings", count: r.unread ?? 0 });
                }
                const data = (await client.listPings({
                    unreadOnly: true,
                    limit: limit ?? 100,
                })) as { pings?: Array<{ message_id: number }> } | undefined;
                return asText({ kind: "pings", ...((data as object) ?? {}) });
            }

            // #800 david `unyzvx` : FIFO est consumer-scoped (cross-project)
            // by default. Explicit `project` arg narrows ; otherwise we pass
            // null and get the full consumer FIFO. The previous
            // `resolveProject(project)` defaulted to $AIBALL_PROJECT which
            // contradicted the design (cross-project fan-outs invisible).
            const proj = project ? client.resolveProject(project) : null;
            if (wantCountOnly) {
                const r = (await client.unreadCount(proj)) as { count?: number };
                return asText({ kind: "project", project: proj, count: r.count ?? 0 });
            }
            const data = (await client.unread(proj, limit ?? 100, since)) as
                | { messages?: Array<{ id: number }> }
                | undefined;
            return asText({ kind: "project", ...((data as object) ?? {}) });
        },
    );

    server.registerTool(
        "arbitrage",
        {
            description:
                "#697 F5 — the pending plan / resolution decisions on tickets THIS agent reports, waiting for your accept / reject. The 'ball in MY court' lens: the inverse of `my_pending_tickets` (your drafts waiting on a moderator). **Answers as lines**, newest first, one decision per line: `#<ticket>:<hashid>`, kind, project, who proposed it, date, ticket title — plus `superseded by <hashid>` on an older amendment (only the latest decision on a ticket needs an answer). An index, not a read: `summary_until` is left out by default, because stacked across dozens of tickets it was most of the payload — pass `full: true` to print it under each line, or open the thread. Every decision is counted in the header; when `limit` cuts the list, the header says how many are not shown.",
            inputSchema: {
                full: z
                    .boolean()
                    .optional()
                    .describe("If true, print each decision's summary_until on the line below it. Default false — the index alone."),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe(`Max decisions to print. Default ${ARBITRAGE_DEFAULT_LIMIT}. When it cuts, the header says how many are not shown.`),
            },
        },
        async ({ full, limit }) => {
            const r = await client.myArbitrage();
            const { meta, lines } = renderArbitrage(r.decisions ?? [], { full: full === true, limit });
            return asLines(meta, lines);
        },
    );

    server.registerTool(
        "poll",
        {
            description:
                "Snapshot of the agent's context AND what's waiting for them. Call this on session boot AND any time you want to see if anything new requires attention. Default scope is slim AND project-scoped when AIBALL_PROJECT is set (only the relevant project's counters and pending lists are returned). Pass `all_projects: true` for the cross-project view. My_pending_tickets / my_pending_comments are returned in summary mode (header only, no body) by default — pass `full_pending: true` if you need bodies. The pending lists are capped (`pending_limit`, default 50); when one is cut, `my_pending_tickets_more` / `my_pending_comments_more` is true, so a cut list never passes for complete.\n\n`unread_pings` and `unread_project` are informational — the wake-injection pipeline owns seen-tracking now (#826 david `74x46c`). Do NOT call `unread({mark_read: true})` to drain : that flag was removed because draining-without-acting was a footgun (agent marked events seen and never acted → events lost). Read `unread({pings: true})` or `unread({...})` if you want to SEE what's queued, but the queue clears via wake-inject (head-FIFO auto-ack) and explicit ticket reads, not via an MCP-side ack call.",
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
                pending_limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe("Max rows in my_pending_tickets / my_pending_comments. Default 50. A cut list sets my_pending_tickets_more / my_pending_comments_more."),
            },
        },
        async ({
            include_subscriptions,
            include_projects,
            all_projects,
            full_pending,
            pending_limit,
        }) => {
            const wantSubs = include_subscriptions === true;
            const wantProjects = include_projects === true;
            const allProjects = all_projects === true;
            const scopeProject =
                !allProjects && client.defaultProject ? client.defaultProject : null;
            const summaryPending = full_pending !== true;
            const pendingLimit = pending_limit ?? 50;
            // #2198 — project filter, body projection and cap all happen in the
            // daemon. One row over the limit is asked for, so a cut list can say so.
            const pendingOpts = { project: scopeProject, summary: summaryPending, limit: pendingLimit + 1 };
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
                client.myPendingTickets(pendingOpts).catch(() => []),
                client.myPendingComments(pendingOpts).catch(() => []),
                client.pingsCount().catch(() => ({ unread: 0 })),
                client
                    .bookends({ project: scopeProject ?? undefined })
                    .catch(() => ({ first: null, last: null })),
            ]);
            const rawStats = Array.isArray(projectStats) ? projectStats : [];
            const stats = scopeProject
                ? rawStats.filter((p) => p.name === scopeProject)
                : rawStats;
            const openTickets: Record<string, number> = {};
            let openTicketsTotal = 0;
            for (const p of stats) {
                const n = typeof p.open_count === "number" ? p.open_count : 0;
                openTickets[p.name] = n;
                openTicketsTotal += n;
            }
            // #2198 — the daemon now filters by project and drops bodies before
            // anything crosses the socket; it used to ship every body (62% of the
            // bytes) for this process to throw away. What is left here is the cut.
            const cutPending = (rows: unknown): { rows: unknown[]; more: boolean } => {
                const arr = Array.isArray(rows) ? rows : [];
                return arr.length > pendingLimit
                    ? { rows: arr.slice(0, pendingLimit), more: true }
                    : { rows: arr, more: false };
            };
            const pendingTickets = cutPending(myPending);
            const myPendingOut = pendingTickets.rows;
            // #1164 S1 — "what should I go execute now" : accepted plans of
            // mine with no action from me since. Scoped like the rest.
            let plansToExecute: unknown[] = [];
            try {
                const r = await client.plansToExecute() as { plans?: unknown[] };
                plansToExecute = (r.plans ?? []).filter((p) =>
                    !scopeProject || (p as { project?: string }).project === scopeProject);
            } catch { /* degrade silently */ }
            // #1819 — best-effort: a failed lookup costs the presence facts,
            // never the poll. Silence here reads as "unknown", which is the
            // honest answer when we could not ask.
            let presence: unknown = null;
            try {
                presence = await client.presence(scopeProject ?? null);
            } catch { /* degrade silently */ }
            const pendingComments = cutPending(myPendingComments);
            const myPendingCommentsOut = pendingComments.rows;
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
                 *  (not closed, not rejected). */
                open_tickets: openTickets,
                open_tickets_total: openTicketsTotal,
                /** Bookend tickets in scope — first (oldest) and last
                 *  (most recent). Cross-project, ordered by id. */
                first_ticket: (bookends as { first?: unknown }).first ?? null,
                last_ticket: (bookends as { last?: unknown }).last ?? null,
                /** #1164 S1 — compact ids of my moderation-pending tickets
                 *  (the list below has the rows ; this is the at-a-glance
                 *  answer to "WHICH ones", zero extra fetch). */
                my_pending_ids: (Array.isArray(myPendingOut) ? myPendingOut : [])
                    .map((m) => (m as { id?: number }).id)
                    .filter((v): v is number => typeof v === "number"),
                /** #1164 S1 — accepted plans awaiting MY execution (latest
                 *  plan decision = accepted, and I haven't acted since). */
                plans_to_execute: plansToExecute,
                /** #1819 — is a human around? FACTS, not a verdict.
                 *
                 *  `last_human_message_age_sec` is the one to reason on: pick
                 *  your own threshold from what you are about to commit, since
                 *  three minutes is enough to decide a rename and nowhere near
                 *  enough for a refactor. A boolean here would have frozen that
                 *  threshold for every agent and every gesture.
                 *
                 *  `loop_state_age_sec` is the guard against reading a dead
                 *  timer as a departed human: a stale heartbeat means UNKNOWN,
                 *  not absent. And `loop_presence_word` measures presence AT
                 *  THE TERMINAL, which is not the same as availability — david
                 *  pilots from the web UI while deliberately leaving the loop
                 *  AFK, and in that regime the word reads `loop`. */
                presence,
                my_pending_tickets: myPendingOut,
                ...(pendingTickets.more ? { my_pending_tickets_more: true } : {}),
                /** Pending comments authored by this agent (#B.69). Needed
                 *  even in `auto-reply` since the strategy can flip to
                 *  `manual` at any moment — comments stuck in moderation
                 *  should always be visible to their author. */
                my_pending_comments: myPendingCommentsOut,
                ...(pendingComments.more ? { my_pending_comments_more: true } : {}),
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
