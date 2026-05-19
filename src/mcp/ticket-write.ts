/**
 * Ticket-write MCP tools (carved out of src/mcp.ts in #B.213 phase
 * 4.A on 2026-05-19). Behavior-preserving move.
 *
 * Tools: ticket_new, ticket_reply, ticket_close, ticket_update,
 * ticket_decide.
 *
 * Exposed entry point: `registerTicketWriteTools(server)`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client, effectiveBy } from "./_helpers.js";

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

export function registerTicketWriteTools(server: McpServer): void {
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
                priority: z
                    .enum(["low", "normal", "high", "urgent"])
                    .optional()
                    .describe(
                        "Urgency hint (#B.222) orthogonal to intent. urgent = drop everything to handle; high = next available turn; normal = default (omit); low = pick up when idle. Influences ticket_list sort + listPings secondary tiebreaker + poll my_pending order. Choose deliberately: most tickets are 'normal'.",
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
        async ({ project, title, summary, body, intent, priority, broadcast, by_agent, parent_id, tags }) => {
            const proj = client.resolveProject(project);
            const res = (await client.postMessage({
                project: proj,
                kind: "ticket_created",
                title,
                summary,
                body,
                intent,
                priority,
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
                "Post a reply within a ticket thread. `target_id` is either a ticket id (→ top-level comment on the ticket) or a comment id (→ nested reply to that specific comment, Gmail-style). Both produce a comment_added; only parent_id differs.\n\n**`summary_until` is required** (#B.130). It's a one-line **ticket state snapshot AFTER this comment lands** — written so a future agent (or you on next session) can resume the ticket from JUST this line, without re-reading any prior body. NOT a summary of what you just said. See the `summary_until` schema description below for the contract + good/bad examples. The API rejects comment_added without it (HTTP 400).\n\nOptional `then` lets the author tag the comment with a decision intent or chain a unilateral state mutation, in the same call:\n- `then: \"resolved\"` — tag the comment as a *resolution decision* (#B.129). The comment carries `meta.decision={kind:\"resolution\",status:\"pending\"}` and the reporter validates it via accept/reject. Closing the ticket auto-accepts any dangling resolution decisions. The 'decision-on-comment' paradigm: the audit lives in the thread, no separate lifecycle row.\n- `then: \"plan\"` — tag the comment as a *plan proposal* (#B.243), symmetric to `resolved` but for HOW-to rather than DONE. The comment carries `meta.decision={kind:\"plan\",status:\"pending\"}` and the reporter validates the approach before execution. Accepted plan = go-signal (the ticket re-enters actionable so the agent picks it up to execute); pending plan gates actionable just like a pending resolution.\n- `then: \"close\"` — close the ticket. Owner-bypass when posted by the reporter.\n- `then: \"reopen\"` — reopen a closed ticket (resets resolved too).\n\nUse `then: \"resolved\"` when you've completed the work and propose to close; use `then: \"plan\"` when you've sketched HOW you'll tackle the ticket and want the reporter to validate the approach first. Both post a single comment that also functions as a pending proposal — the reporter sees ONE accept/reject pair under the composer instead of two separate steps.\n\nIf you need more info before you can proceed, just post a plain comment with your question — there is no agent→human \"blocked\" signal anymore (it induced misuse where agents temporized with blocked instead of asking; the conversational comment IS the right primitive).",
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
                        [
                            "One-line **TICKET STATE SNAPSHOT** after this comment (#B.130) — the canonical resume-point for the next agent reading this ticket.",
                            "",
                            "Contract: when an agent reads the ticket in brief mode, this string PLUS the latest comment body must be enough to know what's happening and what's next. The string is your context handoff to future-you — not a description of your own action.",
                            "",
                            "RULE OF THUMB: imagine someone opens this ticket fresh tomorrow, reads ONLY this line + the latest body. Can they (a) understand current status, (b) tell who's expected to do what next, (c) spot open decisions/blockers? If no, rewrite.",
                            "",
                            "GOOD (state-framed):",
                            "  - 'Phase B done; B.3 migration backfilled 10 rows. Awaiting david accept on UI cartouche.'",
                            "  - 'Awaiting explicit go for phase B (typed relations + parent_ticket_id migration, ~400-500 lines).'",
                            "  - 'Search open-filter now excludes lifecycle-closed tickets; pending david review.'",
                            "",
                            "BAD (action-framed — describes what YOU did, not ticket state):",
                            "  - 'Shipped B.2 slice 2/3: add-relation widget.'  ← OK as part of the body, not as the snapshot",
                            "  - 'Phase B.2 complete (chips + add widget + per-chip change-kind/remove menu).'  ← delta, not state",
                            "  - 'Plan: B.5 → B.4 → B.3.'  ← decision, doesn't say where the work currently sits",
                            "",
                            "How a state-frame differs: include 'awaiting X', 'blocked on Y', 'next step Z', open questions, current ownership. Skip 'I added', 'I shipped', 'I refactored' — those are the body's job.",
                            "",
                            "Latest-wins: only the most recent summary_until is canonical; older ones become invisible in brief reads. No length cap (free-text field like body) — long enough to carry the whole ticket state. Humans are exempted (the requirement targets agents — humans can be terse). Mandatory for agents — the API rejects comment_added without it (HTTP 400).",
                        ].join("\n"),
                    ),
                then: z
                    .enum(["resolved", "plan", "close", "reopen"])
                    .optional()
                    .describe(
                        "Optional intent on the comment. `resolved` (#B.129) = tag the comment as a resolution decision (`meta.decision={kind:\"resolution\",status:\"pending\"}`); the reporter accept/reject — no separate ticket_resolved row anymore, the comment IS the proposal and the audit lives on it. `plan` (#B.243) = symmetric to `resolved` for plan proposals (`meta.decision={kind:\"plan\",status:\"pending\"}`): use it when the comment body describes HOW you intend to tackle the ticket and you want the reporter to validate the approach before you execute. Accepted plan = go-signal (the agent re-enters actionable to execute); pending plan gates actionable identically to pending resolution. `close` = close the ticket (reporter-only). `reopen` = bring a closed ticket back. `close`/`reopen` are still emitted as distinct lifecycle event rows; `resolved` and `plan` are comment+decision sidecars. There is no agent→human `blocked` option — post a plain comment with your question if you need info before proceeding.",
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
                : then === "resolved" || then === "plan"
                  ? "comment_added"
                  : then === "close"
                    ? "ticket_closed"
                    : "ticket_reopened";
            const decision_kind =
                then === "resolved" ? "resolution" : then === "plan" ? "plan" : undefined;
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
                priority: z
                    .enum(["low", "normal", "high", "urgent"])
                    .nullable()
                    .optional()
                    .describe(
                        "New urgency hint (#B.222, owner-bypass). low / normal / high / urgent. Pass null to reset to 'normal'.",
                    ),
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
        async ({ ticket_id, title, summary, body, intent, priority, broadcast, postponed_until }) => {
            const results: Record<string, unknown> = { ticket_id };
            // Each field maps to its own HTTP endpoint. Apply in this
            // order: edit fields first (they may change the title/body the
            // following flips display), then broadcast, then postpone.
            if (
                title !== undefined ||
                body !== undefined ||
                summary !== undefined ||
                intent !== undefined ||
                priority !== undefined
            ) {
                results.edit = await client.edit(ticket_id, { title, summary, body, intent, priority });
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
                throw new Error("ticket_update needs at least one field — pass title/body/intent/priority/broadcast/postponed_until");
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
}
