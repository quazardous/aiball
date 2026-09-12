/**
 * Ticket-domain routes (carved out of api.ts in #B.213 phase 1.G on
 * 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   GET   /tickets/bookends                  — slim inbox edges (#B.68)
 *   GET   /inbox                             — unified inbox view
 *   GET   /tickets                           — list with filters (#B.83/87)
 *   POST  /tickets/:id/mark-read             — per-consumer ack (#B.191)
 *   POST  /tickets/:id/mark-unread
 *   PATCH /tickets/:id                       — broadcast toggle
 *   POST  /tickets/:id/postpone              — snooze (#B.329)
 *   POST  /tickets/:id/unsnooze
 *   GET   /tickets/:id/relations             — typed relations (#B.123 phase B)
 *   POST  /tickets/:id/relations
 *   GET   /tickets/:id                       — header / brief / digest / full
 *
 * Local helper `enrichRelationStages` is kept private — only the GET
 * /tickets/:id thread builder uses it.
 */
import { resolvesTicket } from "../ticket-transitions.js";
import { Router, type Request, type Response } from "express";
import { levelsVisibleTo, seesLevel } from "../db/consumers.js";
import { ERROR_CODES } from "../domain.js";
import {
    listMessages,
    listMessageTags,
    tagsForMessages,
    resolveAttachments,
    type Message,
    type MessageStatus,
    setTicketPostpone,
    listSubTickets,
    subTicketCounts,
    getTicketStages,
    getTicketBookends,
    getMessage,
    getMessageByHashid,
    markTicketSeen,
    markTicketUnseen,
    ticketUnreadFlags,
    ticketAgentLastActivity,
    ticketOthersLastActivity,
    addTicketTokenUsage,
    getTicketTokenUsage,
    isHuman,
    insertTypedRelation,
    listTypedRelationsForTicket,
    listPendingChildren,
    lineageWouldCycle,
    setTicketOwner,
    setTicketAssignment,
    setTicketClaim,
    ticketsClaimedBy,
    ticketSelfLastActivity,
    releaseTicketAssignment,
    releaseTicketClaim,
    upsertTicketSubscription,
    listTicketSubscriptionsForTicket,
    getConsumer,
} from "../db.js";
import { computeActionableTicketIds } from "../db/projects.js";
import { ticketHasPayload } from "../db/payloads.js";
import { computeTicketFlags, buildTicketFlagsContext } from "../db/ticket-flags.js";
import { listProjectSubscribers, listSubscriptions } from "../db/subscriptions.js";
import { isAssignmentLive, claimsToAutoRelease, pickFocusClaim } from "../db/assignment-gate.js";
import { compareWorkOrder, computeHotFocus, type WorkOrderCtx } from "../db/work-order.js";
import { assignWindowSec } from "../autopoll/config.js";
import { RELATION_KINDS, isRelationKind, isLineageRelationKind, relationAxis, type RelationKind } from "../relations.js";
import { broadcast } from "../ws.js";
import { parseMeta } from "../questions.js";

import { buildInboxRow, buildInboxRowContext, hotWindowSec } from "./inbox-row.js";
import { getInboxAgg, isLiveDecision } from "../db/inbox-agg.js";
import { DECISION_KINDS } from "../decisions.js";
import { applyModeration } from "./moderation.js";

/**
 * #2072 — the ticket's state AFTER a mutation, in the exact shape the list
 * uses. david: "quand le front pousse une modif sur un endpoint de l'API,
 * l'API renvoie les données à jour de tout l'objet".
 *
 * Returned ALONGSIDE each endpoint's existing acknowledgement rather than
 * instead of it: the acknowledgements are a subset, and replacing them would
 * break every caller for no gain. A front that wants to patch its cache reads
 * `ticket`; one that doesn't ignores it.
 *
 * Null when the ticket vanished under us — a caller that just mutated it will
 * still get its acknowledgement.
 */
function ticketStateAfter(id: number, consumerId: string) {
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return null;
    return buildInboxRow(t, buildInboxRowContext([t], consumerId, t.project));
}
import { badRequest, consumerOf, notFound, withTags, withTagsOne, withVotes } from "./_helpers.js";
import { tagMessageAsStep, untagMessageStep } from "../db/messages.js";
import { importUpstream, AlreadyCoupledError } from "../upstream-import.js";
import { exportUpstream } from "../upstream-export.js";
import type { AuthenticatedRequest } from "../auth.js";
import { moveTicketTo } from "../messages.js";
import { paginateFeed, type FeedPagination } from "./feed-paginate.js";

export const ticketsRouter = Router();

/** #402 levier 1 — hot-window (seconds) read from the global config yaml
 *  (`~/.config/aiball/config.yaml` → `hot_window_sec:`, david `xkehmv` D2).
 *  Default 1200s (#829 david `egz5b5` : "passe le hot à 20 minutes,
 *  rearmable" — la fenêtre est rearmée naturellement par chaque activité
 *  via `last_actor_at`, donc 20 min sliding suffit). Read once per
 *  ticket_list (the sort), not per row, so the yaml parse is cheap.
 *  Falls back to the default on any read/parse error. */
/**
 * #1835 — a decision can live on the TICKET, not only on a comment.
 * `ticket_new({then:"plan"})` stores it in the ticket's own `meta`, and the
 * inbox aggregate only ever walks `comment_added` rows — so those tickets
 * showed no pending flag at all while the thread view happily rendered an
 * "accept plan" button from the same data.
 *
 * That mattered more than a missing tint: a pending decision GATES the ticket
 * out of the agent's actionable pool. The ticket left the agent's queue and
 * signalled nothing to the human, so nobody was looking at it.
 *
 * `kind === null` asks "is there any pending decision here", used where only
 * the existence matters.
 */
// #2072 — both moved next to the row builder that needs them, so it does not
// import the router that imports it back. Re-exported: every existing caller
// keeps its import path.
export { ticketDecision, hotWindowSec } from "./inbox-row.js";

/**
 * #352: change a ticket's owner (= its `by_agent` / reporter — no model
 * change). Human-moderator only. Subscribes the new owner so they get the
 * thread's pings; owner-bypass (close/reopen) follows `by_agent`.
 */
ticketsRouter.post("/tickets/:id/owner", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "owner change is moderator-only" });
    }
    const by_agent = typeof req.body?.by_agent === "string" ? req.body.by_agent.trim() : "";
    if (!by_agent) return badRequest(res, "by_agent required (non-empty string)");
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    setTicketOwner(id, by_agent);
    upsertTicketSubscription(by_agent, id);
    res.json({ ticket_id: id, by_agent, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * #418: assign / claim a ticket.
 *  - PUSH (`assignee` = someone other than the caller): human/moderator only,
 *    like owner-change. is_claim=0, assigned_by=the human.
 *  - CLAIM (no `assignee`, or `assignee` = caller): any consumer self-assigns.
 *    is_claim=1, assigned_by=caller.
 * Subscribes the assignee to the thread. A live assignment narrows the ticket
 * out of OTHER consumers' actionable pool until it expires (assign_window_sec),
 * is released, or the ticket closes. The assignee's own gating is unchanged.
 */
ticketsRouter.post("/tickets/:id/assign", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const caller = consumerOf(req);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const rawAssignee = typeof req.body?.assignee === "string" ? req.body.assignee.trim() : "";
    const target = rawAssignee || caller; // no assignee → self-claim
    const isClaim = target === caller;
    if (!isClaim && !isHuman(caller)) {
        return res.status(403).json({
            error: "assigning another consumer is moderator-only (an agent can only claim for itself)",
        });
    }
    // #575 david : un agent ne peut pas claim un ticket encore pending
    // moderation. Symétrique au guard #569 (`then:resolved/plan` sur
    // pending) : claim = "I'm focusing on this NOW" = work intent. Sur un
    // ticket pending l'agent ne peut rien faire d'utile (poster un comment
    // peut être bloqué par la rule engine, proposer une résolution est
    // déjà rejeté par #569), donc claim n'a aucun sens. Humains bypass :
    // un moderator peut claim pendant la review (focus de modération).
    // Push-assign (isClaim=false) reste discretionnel : moderator peut
    // pré-déléguer un pending à un agent, qui sera notifié à l'approve.
    // Couvre aussi MCP `ticket_claim` qui delegate via
    // `client.assignTicket(head.id)` (cf. src/mcp/ticket-write.ts).
    if (isClaim && t.status !== "approved" && !isHuman(caller)) {
        return res.status(409).json({
            error: `cannot claim a ticket in status "${t.status}" — the reporter must moderate (approve) the ticket first`,
            code: ERROR_CODES.PARENT_PENDING_MODERATION,
        });
    }
    // #2241 — an agent claims only within its scope: a cto agent `roadmap` and
    // `milestone` tickets, a coder agent tasks. Same claim, different scope. A
    // human is not restricted, and neither is a moderator's push-assignment.
    // Covers MCP `ticket_claim({ticket_id})`, which reaches here directly; the
    // zero-arg form already picks from the scoped actionable pool.
    if (isClaim && !isHuman(caller) && !seesLevel(caller, t.level)) {
        return res.status(403).json({
            error: `#${t.id} is a ${t.level ?? "task"} ticket, and this agent works on ${(levelsVisibleTo(caller) ?? []).join(" and ")} tickets only`,
        });
    }
    // #436: self → CLAIM (focus, transient); other → ASSIGNMENT (responsibility,
    // persistent). Two distinct fields now — a ticket can be both.
    let releasedClaims: number[] = [];
    // #523 — surfaced when this assign auto-releases a prior claim by a
    // DIFFERENT consumer (cf. setTicketAssignment).
    let assignReleasedClaim: { ticket_id: number; claimant: string } | null = null;
    if (isClaim) {
        // #439 one-focus: picking this up auto-releases my OTHER live claims I
        // never commented on since grabbing them (bare pickups, zero work lost),
        // so an agent holds one focus at a time instead of stacking locks. Claims
        // I've actually worked (a self comment after claimed_at) survive. Runs
        // BEFORE the new claim so re-engaging the head I already hold is a no-op.
        const myClaims = ticketsClaimedBy(caller);
        if (myClaims.length > 0) {
            const selfActMs = new Map<number, number>();
            for (const [tid, iso] of ticketSelfLastActivity(caller, myClaims.map((c) => c.id))) {
                const ms = Date.parse(iso);
                if (!Number.isNaN(ms)) selfActMs.set(tid, ms);
            }
            releasedClaims = claimsToAutoRelease(
                myClaims.map((c) => ({ id: c.id, claimedAt: c.claimed_at })),
                selfActMs,
                id,
                Date.now(),
                assignWindowSec() * 1000,
            );
            for (const rid of releasedClaims) releaseTicketClaim(rid);
        }
        setTicketClaim(id, caller);
    } else {
        // #523 — setTicketAssignment auto-releases the existing claim if
        // claimant ≠ new assignee. Surface who got ejected for audit +
        // for the broadcast below.
        const ar = setTicketAssignment(id, target, caller);
        if (ar.released_claim) {
            // No dedicated ping for the ex-claimant: the broadcast below
            // refreshes their UI on the next SSE tick (claim icon drops,
            // own-claim boost in work-order drops too).
            assignReleasedClaim = ar.released_claim;
        }
    }
    upsertTicketSubscription(target, id);
    // #448 david: the claim landed in the DB but the UI didn't reflect it live —
    // this path never broadcast, so an open inbox/thread kept showing the
    // pre-claim state until a manual reload. Emit message_edited on each
    // touched ticket (the new claim/assign + any claims the one-focus rule
    // auto-released) so the WS relay fires inbox.refresh + thread.refresh and
    // the holder icon (lists + header) appears/clears in real time. Mirrors the
    // moveTicket broadcast. releasedClaims never includes `id` (built excluding
    // the new claim), so no dup.
    for (const rid of [id, ...releasedClaims]) {
        const updated = getMessage(rid);
        if (updated) broadcast({ type: "message_edited", data: updated });
    }
    res.json({
        ticket_id: id,
        assignee: isClaim ? null : target,
        claimant: isClaim ? caller : null,
        assigned_by: caller,
        is_claim: isClaim,
        // #439: which other live claims this self-claim auto-released (one-focus).
        released_claims: releasedClaims,
        // #523 : claim libéré par CET assignment (ex-claimant ≠ nouveau assignee).
        // null si pas de claim avant, ou self-assign (assignee == claimant).
        assign_released_claim: assignReleasedClaim,
    });
});

/**
 * #418: release a ticket's assignment / claim — back to the shared pool. The
 * current assignee or a human moderator can release.
 */
ticketsRouter.post("/tickets/:id/release", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const caller = consumerOf(req);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    // #436: release whatever the caller holds. An agent releases its own CLAIM;
    // the assignee or a moderator releases the ASSIGNMENT. A caller who holds
    // neither (and isn't a moderator) can't release someone else's hold.
    const holdsClaim = t.claimant === caller;
    const canReleaseAssignment = (t.assignee === caller) || isHuman(caller);
    if (!holdsClaim && !canReleaseAssignment) {
        return res.status(403).json({ error: "only the claimant, the assignee, or a moderator can release this ticket" });
    }
    if (holdsClaim) releaseTicketClaim(id);
    if (canReleaseAssignment && t.assignee) releaseTicketAssignment(id);
    // #448: broadcast so the holder icon clears live (same fix as assign).
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, released: true, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * #404: push a turn's token-usage delta onto a ticket (called by the claude-loop
 * Stop-hook once the capture side lands). Additive — accumulates. Body:
 * `{ in?, out?, cache_w?, cache_r? }`. Silently no-ops on an unknown ticket id
 * (the FK on the table rejects it) so a stale marker never errors the hook.
 *
 * #439: the `:id` from the loop-side capture is the volatile `active-ticket`
 * MARKER — but that flips on any incidental ticket-scoped write within the turn.
 * So we RE-ANCHOR server-side onto the caller's most-recently-claimed LIVE claim
 * (the durable focus), and fall back to the passed marker only when the caller
 * holds no live claim. Policy lives here, where the claim does; the loop side
 * stays dumb (keeps posting the marker).
 */
ticketsRouter.post("/tickets/:id/token-usage", (req: Request, res: Response) => {
    const markerId = Number(req.params.id);
    const caller = consumerOf(req);
    // #439: anchor on the held claim; the marker is the fallback.
    const focus = pickFocusClaim(
        ticketsClaimedBy(caller).map((c) => ({ id: c.id, claimedAt: c.claimed_at })),
        Date.now(),
        assignWindowSec() * 1000,
    );
    const id = focus ?? markerId;
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const b = (req.body ?? {}) as { in?: unknown; out?: unknown; cache_w?: unknown; cache_r?: unknown };
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    addTicketTokenUsage(id, { in: n(b.in), out: n(b.out), cacheW: n(b.cache_w), cacheR: n(b.cache_r) });
    // #439: surface both so a stale-marker vs claim-anchor mismatch is debuggable.
    // #2072 — usage changes the row's token chip, so the row comes back too.
    res.json({ ticket_id: id, marker_id: markerId, ok: true, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * #352: list a ticket's EXPLICIT subscriptions (follows + mutes), for the
 * moderator's inline manage panel. Moderator-only — it manages who else gets
 * pinged. Owners pinged by project role aren't listed (explicit-only, david).
 */
ticketsRouter.get("/tickets/:id/subscriptions", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "subscription management is moderator-only" });
    }
    res.json({ ticket_id: id, subscriptions: listTicketSubscriptionsForTicket(id) });
});

/**
 * Inbox bookends: oldest + newest non-rejected ticket matching the
 * scope. Used by the slim `poll()` (per #B.68) so agents see the
 * inbox edges without paying for the full subscriptions/projects blob.
 *
 * Query:
 *   - project=NAME    (optional) restrict to a project; otherwise cross-project.
 *   - include_snoozed=1  include snoozed tickets in the scope.
 */
ticketsRouter.get("/tickets/bookends", (req, res) => {
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const includeSnoozed = req.query.include_snoozed === "1";
    res.json(getTicketBookends({ project, includeSnoozed }));
});

/**
 * Unified inbox view: one row per ticket, decorated with the latest activity
 * timestamp (so a new pending comment bumps its parent ticket to the top) and
 * with pending-comment counts so the moderator sees at a glance what needs
 * attention. Filter by status:
 *   - "pending"  → tickets that are themselves pending OR have ≥1 pending comment
 *   - "approved" → tickets with status=approved
 *   - "rejected" → tickets with status=rejected
 *   - undefined  → every ticket regardless of status
 */
/**
 * Priority ranks, shared by the inbox sort (#2071) and the work-order sort.
 * One table: two copies would be a place for the two orderings to disagree
 * without anyone noticing.
 */
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

ticketsRouter.get("/inbox", (req, res) => {
    const project = req.query.project as string | undefined;
    const status = req.query.status as MessageStatus | undefined;
    const onlyOpen = req.query.open === "1";
    const intentFilter = req.query.intent as string | undefined;
    // #B.222: optional priority filter — accepts a single value (low /
    // normal / high / urgent) and narrows the list to tickets whose
    // priority matches. "all" or absent = no filter.
    const priorityFilter = req.query.priority as string | undefined;
    // Include snoozed tickets in the open-inbox view (per #B.329). The
    // toggle in the header flips this on so a moderator can see what's
    // currently set aside. Default off — snoozed rows are hidden the
    // same way closed ones are.
    const includePostponed = req.query.include_postponed === "1";
    // Read state is per-consumer — resolved from the X-Aiball-Consumer
    // header (UI sets this once globally) with AIBALL_HUMAN fallback.
    // Each row gets an `unread` boolean computed from the pings table
    // (≥1 unseen ping on the thread for that consumer).
    const consumerId = consumerOf(req);

    let tickets = listMessages({ kind: "ticket_created", project });
    // #2072 — `ids` narrows to specific tickets so a client can refresh ONE row
    // instead of a page. Every other filter still applies, and that is the
    // useful part: an empty answer means "this ticket no longer belongs in this
    // view", which is exactly what a cache needs to hear to drop the row.
    // Paging is skipped for an id query — the caller already named the set.
    const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";
    const wantedIds = idsParam
        ? new Set(idsParam.split(",").map((n) => Number(n.trim())).filter(Number.isSafeInteger))
        : null;
    if (wantedIds) tickets = tickets.filter((t) => wantedIds.has(t.id));
    // #2072 — the row is built by the shared builder, so a mutation that
    // returns "the updated object" returns exactly what the list holds.
    const rowCtx = buildInboxRowContext(tickets, consumerId, project);
    let rows = tickets.map((t) => buildInboxRow(t, rowCtx));

    if (status === "pending") {
        rows = rows.filter((r) => r.status === "pending" || r.pending_comment_count > 0);
    } else if (status === "approved" || status === "rejected") {
        rows = rows.filter((r) => r.status === status);
    }
    // #479 david : "dans la liste de tickets avec all on voit pas les pending".
    // Renverse la décision #450 (qui excluait les tickets pending du default
    // pour qu'ils ne pollutent pas le backlog). Avec "all" l'utilisateur
    // s'attend à voir EVERY ticket — pending inclus. "pending" reste le
    // sous-ensemble focalisé (pending tickets + approved tickets with
    // pending comments). "approved" / "rejected" inchangés.
    if (onlyOpen) {
        rows = rows.filter((r) => !r.closed);
    }
    // Snooze filter applies on every status combination — not just when
    // `open=1`. Otherwise pending+snoozed tickets slip through (regression
    // surfaced after #B.78 enabled snoozing on pending tickets).
    if (!includePostponed) {
        rows = rows.filter((r) => !r.postponed);
    }
    if (intentFilter && intentFilter !== "all") {
        rows = rows.filter((r) => r.intent === intentFilter);
    }
    if (priorityFilter && priorityFilter !== "all") {
        rows = rows.filter((r) => (r.priority ?? "normal") === priorityFilter);
    }

    // #2071 — the UNREAD filter, server-side. This is the one that unblocks
    // everything else: the client computed it from the per-row flag, and the
    // code said so where it paginated ("paginating before that filter would
    // yield ragged pages"), so the endpoint had to return the whole board.
    // The flag was already computed here; only the filter was missing.
    if (req.query.unread === "1") {
        rows = rows.filter((r) => r.unread);
    }

    // #2071 — sort server-side, in the order the board displays. Paging in any
    // other order makes rows insert themselves above the one being read, which
    // is why loading "smallest project first" was the wrong idea however much
    // faster each chunk arrived (david `x3k3pr`). The three orders mirror the
    // client's own; `activity` stays the default the API always had.
    const sortBy = typeof req.query.sort === "string" ? req.query.sort : "activity";
    if (sortBy === "created_desc") {
        rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (sortBy === "created_asc") {
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sortBy === "priority") {
        rows.sort((a, b) => {
            const w = (p: string | null | undefined) => PRIORITY_WEIGHT[p ?? "normal"] ?? 2;
            const d = w(b.priority) - w(a.priority);
            return d !== 0 ? d : b.created_at.localeCompare(a.created_at);
        });
    } else {
        rows.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    }

    // #2071 — page AFTER filtering and sorting, never before. The total goes in
    // a header rather than wrapping the body in an envelope: every existing
    // consumer keeps receiving a plain array, and the pager gets its count.
    //
    // The page SIZE comes from the caller (david `x3k3pr`): it is a user
    // preference kept in localStorage, so hardcoding 25 here would silently
    // ignore whatever the reader chose. No limit at all = the whole list,
    // which is what every non-UI consumer still asks for.
    const total = rows.length;
    res.setHeader("X-Total-Count", String(total));
    const limit = wantedIds ? NaN : Number(req.query.limit);
    if (Number.isFinite(limit) && limit > 0) {
        const offset = Math.max(0, Number(req.query.offset) || 0);
        rows = rows.slice(offset, offset + limit);
    }

    res.json(rows);
});

ticketsRouter.get("/tickets", (req, res) => {
    const project = req.query.project as string | undefined;
    const onlyOpen = req.query.open === "1";
    // #B.232 #234 david: actionable=1 is a stricter form of open=1
    // that ALSO excludes resolved-pending, blocked, and gated tickets
    // (mirrors actionable_count semantics on the sidebar). Used by the
    // wake-CTA so the agent's candidate pool excludes tickets already
    // in awaiting-validation state. Frontend keeps open=1 for the
    // broader "everything not lifecycle-closed" view (david still needs
    // to see resolution proposals to act on them).
    const onlyActionable = req.query.actionable === "1";
    // #432 david: `claimable` is a DIFFERENT, narrower lens than `actionable`.
    // actionable stays inclusive (a follower-broadcast from another project is
    // still actionable/visible); claimable = actionable ∩ {projects where THIS
    // consumer is an `owner`}. Claiming commits you to the work, which belongs
    // to that project's owners — so a project you only `follow` is actionable
    // but not claimable. `ticket_claim` + the wake-CTA head use this set.
    const onlyClaimable = req.query.claimable === "1";
    // The backlog wake set: actionable tickets (ball in my court) UNION
    // open tickets where I was the last actor (ball in their court). Tier
    // 1 sorts first via the existing work-order tiering — actionable
    // collapses into its tier, the others land in "other open".
    // See docs/TICKET_LIFECYCLE.md §5.0.
    const onlyBacklog = req.query.backlog === "1";
    // #461 — predict the POST-DRAIN work-order head. With `assume_drained=1`,
    // the work-order sort treats every currently-unread ticket as if its ping
    // had already been ack'd: the `unread` tier is suppressed, all rows
    // collapse into the `actionable` tier and re-sort by priority/age. The
    // wake builder uses this when it instructs the agent to "drain pings,
    // THEN claim" so the named #X matches what `ticket_claim` will actually
    // claim after the drain (without this flag, the wake names the pre-drain
    // unread-tier head and the agent's drain demotes it before engage runs,
    // surfacing a different ticket — the friction david pointed at). Affects
    // ORDER only; the per-row `unread` boolean still reflects real state.
    const assumeDrained = req.query.assume_drained === "1";
    // Default: when `open=1`, snoozed tickets are hidden (same rule as
    // the inbox). Pass `include_postponed=1` to surface them anyway.
    const includePostponed = req.query.include_postponed === "1";
    // Tag filter — comma-separated names. AND semantics: a ticket must
    // carry EVERY listed tag to match. Unknown tag names are ignored
    // silently rather than 400'ing — keeps the URL lenient.
    const tagsFilter = typeof req.query.tags === "string"
        ? req.query.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    // Verbosity (#B.83 then #B.87 palier 2): default is summary now —
    // header-only payload, no body. Pass `full=1` to
    // re-include bodies. `summary=1` kept as an accepted alias for
    // explicit-summary requests; `summary=0` forces full. The plain
    // default (neither flag) is summary.
    const fullParam = req.query.full;
    const summaryParam = req.query.summary;
    const summary =
        fullParam === "1"
            ? false
            : summaryParam === "0"
              ? false
              : true;
    // Author filter (#B.84): scope to tickets posted by a specific
    // consumer_id. Useful for "my tickets" without scanning the full list.
    const byAgent = typeof req.query.by_agent === "string" && req.query.by_agent
        ? req.query.by_agent
        : undefined;
    // Status filter (#B.84): default "approved" preserves prior behavior;
    // pass "pending" / "rejected" / "any" to widen.
    const statusParam = (req.query.status as string | undefined) ?? "approved";
    const statusFilter: "pending" | "approved" | "rejected" | undefined =
        statusParam === "pending" || statusParam === "approved" || statusParam === "rejected"
            ? statusParam
            : statusParam === "any"
              ? undefined
              : "approved";
    // Substring filter (#B.84): case-insensitive contains on the
    // (edited_)title. Cheap alternative to FTS when looking up a ticket
    // by name.
    const titleContains =
        typeof req.query.title_contains === "string" && req.query.title_contains
            ? req.query.title_contains.toLowerCase()
            : undefined;
    const limit =
        typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
            ? Math.max(1, Math.min(500, Number(req.query.limit)))
            : undefined;
    // since (#B.87): filter on ticket created_at >= since. Accepts any
    // string Date.parse() understands (ISO8601 recommended). Cheap
    // alternative to client-side diff when polling for new tickets.
    const sinceParam = typeof req.query.since === "string" ? req.query.since : undefined;
    const sinceIso = sinceParam && Number.isFinite(Date.parse(sinceParam))
        ? new Date(Date.parse(sinceParam)).toISOString()
        : undefined;

    const created = listMessages({
        status: statusFilter,
        kind: "ticket_created",
        project,
        by_agent: byAgent,
    });

    const closes = listMessages({
        status: "approved",
        kind: "ticket_closed",
        project,
    });
    // #371 follow-up: net closed state must replay reopen too, else a
    // reopened ticket still reads `closed: true` (this handler only checked
    // ticket_closed, unlike /inbox which replays the full lifecycle). The
    // new tiering surfaced it — #305 was reopened yet sorted into the open
    // tier while still flagged closed. Replay closed+reopened in id order.
    const reopens = listMessages({
        status: "approved",
        kind: "ticket_reopened",
        project,
    });
    const closedSet = new Set<number>();
    for (const ev of [...closes, ...reopens].sort((a, b) => a.id - b.id)) {
        if (ev.ticket_id == null) continue;
        if (ev.kind === "ticket_closed") closedSet.add(ev.ticket_id);
        else closedSet.delete(ev.ticket_id);
    }
    const nowStr = new Date().toISOString();

    const tagsMap = tagsForMessages(created.map((m) => m.id));
    const childCounts = subTicketCounts(created.map((m) => m.id));
    // #371 david: every row carries its per-consumer work-landscape flags —
    // `unread` (≥1 unseen ping for this consumer) and `actionable` (in this
    // consumer's actionable pool). Computed once; the ordering below tiers
    // the list by them (unread → actionable → other-open → rest).
    const consumerId = consumerOf(req);
    const unreadMap = ticketUnreadFlags(consumerId, created.map((m) => m.id));
    const { openIds, actionableIds } = computeActionableTicketIds(consumerId);
    // #432: projects this consumer owns (role=owner). A claimable ticket must
    // live in one of these — claiming a follower-only project's broadcast would
    // commit us to another project's work.
    const ownedProjects = new Set(
        listSubscriptions(consumerId)
            .filter((s) => s.role === "owner")
            .map((s) => s.project),
    );
    // #508 — un consumer "spécialiste" (can_claim=false) ne peut RIEN claim
    // via le pool global, peu importe ses owned projects. Pour lui le set
    // claimable = uniquement les tickets explicitement assignés (assignee=lui).
    // Engage / wake-CTA prennent la tête de ce set → le no-claim ne consomme
    // que ce qu'on lui pousse.
    //
    // Phase A2 (`pbkych`) : un hint relayé par le proxy node via le header
    // `x-aiball-no-claim` (loadProxy().noClaimConsumers) compte AUSSI — un OU
    // l'autre suffit (le node "sait" quels consumers locaux sont spécialistes,
    // même si l'admin upstream n'a pas posé le flag DB).
    const consumerRow = getConsumer(consumerId);
    const dbCanClaim = !consumerRow || consumerRow.can_claim !== false;
    const proxyHint = (req as AuthenticatedRequest).no_claim_hint === true;
    const consumerCanClaim = dbCanClaim && !proxyHint;
    const isClaimable = (id: number, proj: string, assignee: string | null): boolean => {
        if (!consumerCanClaim) {
            // Assignment-only : claimable = (assigné à moi ET actionable).
            return assignee === consumerId && actionableIds.has(id);
        }
        return actionableIds.has(id) && ownedProjects.has(proj);
    };
    // #430/#436: tickets the consumer holds a LIVE CLAIM on (claimant = me,
    // within the claim window) — the explicit FOCUS, used as a work-order tiebreak
    // ABOVE hot. #436: reads the dedicated `claimant`/`claimed_at` (was the fused
    // assignee+is_claim). #436 (4): assigned-to-me (a human handed it to me) is a
    // SEPARATE, weaker boost — sorts below own-claim, above hot.
    const claimNowMs = Date.now();
    const assignWindowMs = assignWindowSec() * 1000;
    const ownClaimIds = new Set<number>();
    const assignedToMeIds = new Set<number>();
    // #900 — tickets a un autre agent détient un claim VIVANT. Utilisé par
    // la règle BacklogRules `claimed-by-other` pour exclure ces tickets
    // du backlog/wake du consumer courant (= ils appartiennent à l'autre).
    const claimedByOtherIds = new Set<number>();
    for (const m of created) {
        const isLiveClaim = m.claimant != null && isAssignmentLive(m.claimed_at, claimNowMs, assignWindowMs);
        if (isLiveClaim && m.claimant === consumerId) {
            ownClaimIds.add(m.id);
        }
        if (isLiveClaim && m.claimant !== consumerId) {
            claimedByOtherIds.add(m.id);
        }
        if (m.assignee === consumerId) {
            assignedToMeIds.add(m.id);
        }
    }
    // #404: per-ticket token-effort tally (empty until the capture side lands).
    const tokenUsageMap = getTicketTokenUsage(created.map((m) => m.id));
    // #405/#408/#532 (sfbsdy + neg428) : SPLIT visibility vs sort tiebreak.
    // - `crossAgentHotFocus` → drives the VISIBLE 🔥 flag (everyone sees same,
    //   union of any agent's recent activity + tickets currently claimed).
    // - `selfHotFocus` → per-agent, drives the work-order tiebreak (ranking
    //   MY own focus higher in MY queue — preserves #532 `bmzpfr`). Empty for
    //   humans (no work order applicable).
    const hotWinMs = hotWindowSec() * 1000;

    // #2164 — hot is a TIEBREAK, and was being computed for the whole board.
    //
    // The work order sorts on (tier, priority) first and only consults hot to
    // separate rows that are equal on both. So the rows that hot can possibly
    // move are those whose coarse key is <= the Nth's — everything strictly
    // above is in the page regardless, everything strictly below cannot reach
    // it. Measured on 2164 tickets: a page of 10 has 23 such contenders and a
    // page of 30 has 297, and the three hot reads drop from 143 ms to 2-9 ms.
    //
    // The window includes the strictly-above rows on purpose: two of THEM can
    // tie with each other, and hot decides their relative order inside a page
    // they both belong to.
    const cheapFiltersOnly = !onlyClaimable && !onlyBacklog && !(tagsFilter && tagsFilter.length > 0);
    const coarseKeyOf = (m: { id: number; priority?: string | null }) =>
        ((!assumeDrained && unreadMap.get(m.id)) ? 0 : actionableIds.has(m.id) ? 1 : openIds.has(m.id) ? 2 : 3) * 10
        + (9 - (PRIORITY_WEIGHT[m.priority ?? "normal"] ?? 2));
    /** The rows a cheap-filter query could still put on the page. */
    const cheapCandidates = () => {
        let cand = created;
        if (onlyOpen) {
            cand = cand.filter((m) => {
                const pu = m.postponed_until ?? null;
                return !closedSet.has(m.id) && (includePostponed || !(!!pu && pu > nowStr));
            });
        }
        if (onlyActionable) cand = cand.filter((m) => actionableIds.has(m.id));
        if (titleContains) cand = cand.filter((m) => (m.title ?? "").toLowerCase().includes(titleContains));
        if (sinceIso) cand = cand.filter((m) => m.created_at >= sinceIso);
        return cand;
    };
    let contenders: typeof created | null = null;
    if (cheapFiltersOnly && limit !== undefined) {
        const cand = cheapCandidates();
        if (cand.length > limit) {
            const coarse = [...cand].sort((a, b) => coarseKeyOf(a) - coarseKeyOf(b) || a.id - b.id);
            const cut = coarseKeyOf(coarse[limit - 1]);
            contenders = coarse.filter((m) => coarseKeyOf(m) <= cut);
        } else {
            contenders = cand;
        }
    }
    const selfHotFocus = isHuman(consumerId)
        ? new Set<number>()
        : computeHotFocus(
            ticketSelfLastActivity(consumerId, (contenders ?? created).map((m) => m.id)),
            Date.now(),
            hotWinMs,
        );
    // #2164 david (« pagination mal faite ? ») — the page is chosen BEFORE the
    // expensive half is built.
    //
    // `limit` used to be the last line of this handler: the route built a flags
    // context and a row for every ticket of the project, sorted, then kept ten.
    // Measured on 1038 tickets, `buildTicketFlagsContext` alone costs 651 ms for
    // the whole list against 70 ms for a page.
    //
    // It works because the ORDER does not need the expensive half.
    // `compareWorkOrder` reads priority, tier, own-claim, assigned-to-me and
    // hot — all of them sets computed above, none of them from the flags
    // context. So the order can be settled on the raw rows, cut to the page,
    // and only that page paid for.
    //
    // It applies ONLY when every active filter is decidable without the built
    // row. `claimable` and `backlog_tier` are computed flags, and `tags` needs
    // the tag map, so those queries keep the full path — a fast path that
    // guessed at them would return a plausible page that is simply the wrong
    // one, which is the failure mode this whole ticket family is about.
    const sortCtx: WorkOrderCtx = {
        tierOf: (id) =>
            (!assumeDrained && unreadMap.get(id)) ? 0 : actionableIds.has(id) ? 1 : openIds.has(id) ? 2 : 3,
        priorityWeight: (p) => PRIORITY_WEIGHT[p ?? "normal"] ?? 2,
        isHot: (id) => selfHotFocus.has(id),
        isOwnClaim: (id) => ownClaimIds.has(id),
        isAssignedToMe: (id) => assignedToMeIds.has(id),
    };
    // The page is chosen from the CONTENDERS, which the hot window above
    // already narrowed to the rows a tiebreak could still move. Sorting them
    // with the full comparator and cutting gives the same page as sorting the
    // whole board would, because everything excluded was strictly below the
    // Nth on a key hot cannot change.
    const pageCreated = contenders !== null && limit !== undefined
        ? [...contenders]
            .sort((a, b) => compareWorkOrder(
                { id: a.id, priority: a.priority },
                { id: b.id, priority: b.priority },
                sortCtx,
            ))
            .slice(0, limit)
        : null;
    const buildFrom = pageCreated ?? created;
    const buildIds = buildFrom.map((m) => m.id);

    // #2164 — these two feed the BUILT rows only (the visible flame, and the
    // backlog tier), never the sort, so they follow the page rather than the
    // board. On the full path `buildFrom` is `created` and nothing changes.
    const crossAgentHotFocus = computeHotFocus(
        ticketAgentLastActivity(buildIds),
        Date.now(),
        hotWinMs,
    );
    // #2073 — heat caused by SOMEONE ELSE, which is what a backlog tier should
    // react to. Undefined for a human: the tier then falls back to the visible
    // set, exactly as before, and no human orders a backlog anyway.
    const othersHotFocus = isHuman(consumerId)
        ? undefined
        : computeHotFocus(
            ticketOthersLastActivity(buildIds, consumerId),
            Date.now(),
            hotWinMs,
        );

    // #791 — centralised flag computation. The route used to build
    // 5-6 independent Sets and combine them inline; the route now
    // delegates to `computeTicketFlags(row, ctx)`. Adding a new
    // condition means editing the pure fn, not the route.
    const cooldownSec = typeof req.query.cooldown_sec === "string"
        && Number.isFinite(Number(req.query.cooldown_sec))
        ? Math.max(0, Number(req.query.cooldown_sec))
        : 0;
    const flagsCtx = buildTicketFlagsContext({
        consumerId,
        ticketIds: buildIds,
        nowMs: Date.now(),
        cooldownSec,
        closedSet,
        isClaimable,
        ownClaimIds,
        assignedToMeIds,
        claimedByOtherIds,
        crossAgentHot: crossAgentHotFocus,
        othersHot: othersHotFocus,
        // #1573 — same effective value the claimable lens uses just above.
        canClaim: consumerCanClaim,
    });
    // #2376 — the tickets carrying a live pending decision, read from the same
    // aggregate the inbox badges use, so a row and a badge cannot disagree.
    const pendingDecisionIds = new Set<number>();
    {
        const aggByProject = new Map<string, ReturnType<typeof getInboxAgg>>();
        for (const m of buildFrom) {
            let byTicket = aggByProject.get(m.project);
            if (!byTicket) {
                byTicket = getInboxAgg(m.project);
                aggByProject.set(m.project, byTicket);
            }
            const agg = byTicket.get(m.id);
            if (!agg) continue;
            for (const kind of DECISION_KINDS) {
                if (agg.decisions[kind].pending && isLiveDecision(agg, kind)) {
                    pendingDecisionIds.add(m.id);
                    break;
                }
            }
        }
    }
    const tickets = buildFrom.map((m) => {
        const postponedUntil = m.postponed_until ?? null;
        const postponed = !!postponedUntil && postponedUntil > nowStr;
        const flags = computeTicketFlags(
            {
                id: m.id,
                project: m.project,
                byAgent: m.by_agent ?? null,
                assignee: m.assignee ?? null,
                postponed_until: postponedUntil,
            },
            flagsCtx,
        );
        const base = {
            id: m.id,
            project: m.project,
            title: m.title,
            // Agent-authored summary (#B.87). Falls back to title when
            // unset so consumers always have something printable.
            summary: m.summary ?? null,
            by_agent: m.by_agent,
            status: m.status,
            created_at: m.created_at,
            closed: closedSet.has(m.id),
            scope: m.scope,
            postponed,
            postponed_until: postponedUntil,
            intent: m.intent,
            priority: m.priority ?? "normal",
            parent_ticket_id: m.parent_ticket_id ?? null,
            sub_ticket_count: childCounts.get(m.id) ?? 0,
            // #371 + #791: per-consumer flags. `unread / actionable /
            // claimable / is_claim / hot` keep their wire names for
            // back-compat; new fields (`backlog_tier`, `gated_by_decision`,
            // `backlog_cooled_until`, `last_actor`, `last_actor_at`)
            // surface via the flag bag.
            unread: flags.unread,
            actionable: flags.actionable,
            claimable: flags.claimable,
            backlog_tier: flags.backlog_tier,
            backlog_cooled_until: flags.backlog_cooled_until,
            gated_by_decision: flags.gated_by_decision,
            // #2376 david `a6zkyf` — a `then:` still waiting for its accept,
            // whether or not it gates the ticket: a human's comment hands the
            // ticket back to the agent while the proposal stays pending, and
            // what is then wanted is to confirm or amend it, not to re-triage.
            // The wake reads this to say so.
            pending_decision: pendingDecisionIds.has(m.id),
            last_actor: flags.last_actor,
            last_actor_at: flags.last_actor_at,
            tags: tagsMap.get(m.id) ?? [],
            // #404: accumulated token-effort tally (null until any usage pushed).
            token_usage: tokenUsageMap.get(m.id) ?? null,
            hot: flags.hot,
            // #418/#436: assignment (responsibility, persistent) + claim
            // (focus, transient) are distinct fields.
            assignee: m.assignee ?? null,
            assigned_by: m.assigned_by ?? null,
            assigned_at: m.assigned_at ?? null,
            claimant: m.claimant ?? null,
            claimed_at: m.claimed_at ?? null,
            is_claim: flags.is_claim,
        };
        if (summary) return base;
        return { ...base, body: m.body };
    });

    let result = tickets;
    if (onlyOpen) {
        result = result.filter((t) => !t.closed && (includePostponed || !t.postponed));
    }
    if (onlyActionable) {
        // #265 + #791: actionable lives on the row now. The actionable gate
        // scopes to the requesting consumer and folds in the decision gate.
        result = result.filter((t) => t.actionable);
    }
    if (onlyClaimable) {
        // #432 + #791: claimable = actionable ∩ owned-project, surfaced
        // on the row.
        result = result.filter((t) => t.claimable);
    }
    if (onlyBacklog) {
        // #791: backlog membership is a row-level fact. The flag fn folds
        // in (a) actionable as tier 1, (b) lastActor=me ∩ !decision_gate as
        // tier 2, (c) the #786 cooldown into `backlog_cooled_until`.
        // David <chat> : les tickets en cooldown restent dans le payload
        // (= le CLI les affiche avec un marker dans une section dédiée),
        // pas filter ici.
        result = result.filter((t) => t.backlog_tier !== null);
    }
    if (tagsFilter && tagsFilter.length > 0) {
        const requiredSet = new Set(tagsFilter.map((s) => s.toLowerCase()));
        result = result.filter((t) => {
            const have = new Set((t.tags as { name: string }[]).map((tag) => tag.name.toLowerCase()));
            for (const need of requiredSet) if (!have.has(need)) return false;
            return true;
        });
    }
    if (titleContains) {
        result = result.filter((t) =>
            (t.title ?? "").toLowerCase().includes(titleContains),
        );
    }
    if (sinceIso) {
        result = result.filter((t) => t.created_at >= sinceIso);
    }
    // #B.222 + #371 + #402 david: order the list as a WORK LANDSCAPE. Keys
    // outer→inner (see compareWorkOrder / docs/TICKET_LIFECYCLE.md):
    //   tier (0 unread → 1 actionable → 2 open → 3 rest)
    //   → priority desc (urgent→low, the strongest sort within a tier)
    //   → HOT (#402 levier 1): at equal priority, a ticket in THIS consumer's
    //     hot-zone (their own activity within hot_window_sec) sorts first, so
    //     the wake follows the active conversation instead of a stale oldest
    //     head. Stays within the tier — never crosses unread/actionable.
    //   → id ASC (oldest first, final tiebreak).
    // The `open`/`actionable` filters above only SUBSET the rows; this orders
    // whatever's left. Sets are nested: unread ⊂ actionable ⊂ open.
    {
        // #402/#405/#532 : pour le sort tiebreak on prend SELF (per-agent), pas
        // cross-agent. Le ranking d'un agent suit son propre focus, pas celui
        // des autres (préserve la sémantique #532 `bmzpfr`). Le `hot` row flag
        // au-dessus utilise crossAgent pour la visibility (séparé exprès).
        // #2164 — the same comparator the page was chosen with, hoisted above so
        // the two can never drift apart. Re-sorting an already-ordered page is a
        // no-op; on the full path this is the original behaviour untouched.
        const ctx: WorkOrderCtx = sortCtx;
        if (onlyBacklog) {
            // #791 wahxsj (Q2) — when the caller asked for the backlog,
            // sort by `backlog_tier` first: hot (0) > actionable (1) >
            // waiting (2). Within each backlog tier, fall back to the
            // standard work-order tiebreaks (priority desc, claim,
            // assignment, intra-tier hot, id asc).
            result.sort((a, b) => {
                const ta = a.backlog_tier ?? 99;
                const tb = b.backlog_tier ?? 99;
                if (ta !== tb) return ta - tb;
                return compareWorkOrder(a, b, ctx);
            });
        } else {
            result.sort((a, b) => compareWorkOrder(a, b, ctx));
        }
    }
    if (limit !== undefined) result = result.slice(0, limit);
    res.json(result);
});

ticketsRouter.post("/tickets/:id/mark-read", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    // Optional up_to_id bounds the ack (#B.191) — see markTicketSeen.
    const upToId = req.body?.up_to_id;
    const opts = typeof upToId === "number" && upToId > 0 ? { upTo: upToId } : undefined;
    const r = markTicketSeen(consumerOf(req), id, opts);
    res.json({ ticket_id: id, ...(opts ? { up_to_id: upToId } : {}), ...r, ticket: ticketStateAfter(id, consumerOf(req)) });
});

ticketsRouter.post("/tickets/:id/mark-unread", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const r = markTicketUnseen(consumerOf(req), id);
    res.json({ ticket_id: id, ...r, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * Snooze a ticket (per #B.329). Body: `{ until: ISO8601 }` — the ticket
 * is hidden from the open inbox until that timestamp. The daemon's
 * reveal cron clears the field at the deadline and posts a synthetic
 * `ticket_reopened` so it bounces back.
 *
 * Owner / human-bypass is enforced: only the ticket reporter or the
 * human moderator can snooze. Other agents get a 403 to avoid surprise
 * "where did my ticket go" moments.
 */
ticketsRouter.post("/tickets/:id/postpone", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    // #784 david : snooze is a human-only concern (organisational hide-
    // for-later). An agent should never be aware of "snooze" — even on
    // its own ticket. Only registered humans can postpone.
    if (!isHuman(caller)) {
        return res.status(403).json({
            error: "only a registered human moderator can snooze a ticket",
        });
    }
    const { until } = (req.body ?? {}) as { until?: unknown };
    if (typeof until !== "string" || !until) {
        return badRequest(res, "until (ISO8601 string) required");
    }
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed)) {
        return badRequest(res, `invalid until "${until}" — expected ISO8601`);
    }
    if (parsed <= Date.now()) {
        return badRequest(res, "until must be in the future");
    }
    const iso = new Date(parsed).toISOString();
    const ok = setTicketPostpone(id, iso);
    if (!ok) return notFound(res, "ticket not found");
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: iso, ticket: ticketStateAfter(id, consumerOf(req)) });
});

ticketsRouter.post("/tickets/:id/unsnooze", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    // #784 david : same human-only rule as /postpone — snooze is a
    // human-only concern, and unsnooze is its reverse.
    if (!isHuman(caller)) {
        return res.status(403).json({
            error: "only a registered human moderator can unsnooze a ticket",
        });
    }
    setTicketPostpone(id, null);
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: null, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * Move a ticket (whole thread) to another project (#294). Reporter-or-human
 * only — same authority as postpone/close. The project lives only on the
 * head, so the move is a head update (project + fresh display_seq) plus an
 * in-thread audit comment; broadcast lets both project views update live.
 */
ticketsRouter.post("/tickets/:id/move", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can move this ticket`,
        });
    }
    const { project } = (req.body ?? {}) as { project?: unknown };
    if (typeof project !== "string" || !project.trim()) {
        return badRequest(res, "project (non-empty string) required");
    }
    const target = project.trim();
    if (target === t.project) {
        return badRequest(res, `ticket is already in project "${target}"`);
    }
    const updated = moveTicketTo(id, target, caller);
    // #2072 — the move returns a raw Message, which is what callers have always
    // read. The canonical row rides alongside so a cache patches from the SAME
    // shape here as everywhere else — and a move is precisely when it matters,
    // since changing project can take the row out of the view entirely.
    res.json({ ...updated, ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * #2180 — a ticket's pending children, one level, each with who attached it and
 * when. What the moderator reads before sweeping. A read, open like the other
 * ticket reads.
 */
ticketsRouter.get("/tickets/:id/pending-children", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    res.json({ ticket_id: id, children: listPendingChildren(id) });
});

/**
 * #2180 — approve a ticket's pending children in one gesture. Human only: this
 * is moderation, and an agent able to approve what it hung under an objective
 * would be approving its own work.
 *
 * The body names the ids; there is no "approve all". The moderator approves what
 * they were shown, each id is re-checked here as still a pending child of this
 * ticket, and anything else comes back in `skipped` untouched — so a child
 * attached after the listing, or an unrelated id slipped into the list, is
 * never approved.
 */
ticketsRouter.post("/tickets/:id/approve-pending-children", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({
            error: "approving pending children is moderation — a registered human moderator only",
        });
    }
    const raw = ((req.body ?? {}) as { ticket_ids?: unknown }).ticket_ids;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((n) => !Number.isInteger(n) || (n as number) <= 0)) {
        return badRequest(res, "ticket_ids (a non-empty array of ticket ids — the ones you were shown) required");
    }
    const pending = new Set(listPendingChildren(id).map((c) => c.ticket_id));
    const children = new Set(
        listTypedRelationsForTicket(id).filter((r) => r.kind === "parent_of").map((r) => r.target_ticket_id),
    );
    const approved: number[] = [];
    const skipped: Array<{ ticket_id: number; reason: string }> = [];
    for (const childId of new Set(raw as number[])) {
        const child = getMessage(childId);
        if (!pending.has(childId) || !child || child.status !== "pending") {
            skipped.push({
                ticket_id: childId,
                reason: children.has(childId)
                    ? `not pending (${child?.status ?? "missing"})`
                    : `not a child of #${id}`,
            });
            continue;
        }
        if (applyModeration(child, "approved", caller)) approved.push(childId);
        else skipped.push({ ticket_id: childId, reason: "not found" });
    }
    res.json({ ticket_id: id, approved, skipped });
});

// ---- Typed inter-ticket relations (#B.123 phase B) ------------------------
//
// Append-only events: POST creates a new ticket_relation row. To change a
// kind, POST a new event with the same target; the replay (listTypedRelations
// ForTicket) keeps only the latest per target. To remove, POST kind=ignored
// — acts as a tombstone in the replay. No PATCH/DELETE endpoint; the event
// log is the source of truth.

/**
 * Upstream coupling (GitHub / GitLab), phase 2 — Slice 0: manual import.
 * Fetch an external issue and create a coupled aiball ticket from it. Manual
 * only; nothing here runs automatically. Body: { project?, ref } where `ref`
 * is a bare `gh#123` (needs a default binding) or explicit `gh:owner/repo#123`.
 */
ticketsRouter.post("/tickets/import", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { project?: string; ref?: string; by_agent?: string };
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    if (!ref) return badRequest(res, "ref required (e.g. gh#123 or gh:owner/repo#123)");
    const project = typeof body.project === "string" && body.project ? body.project : undefined;
    if (!project) return badRequest(res, "project required");
    const by_agent = body.by_agent || consumerOf(req);
    try {
        const { ticket, external, provider } = await importUpstream({ project, ref, by_agent });
        return res.status(201).json({ ticket: withTagsOne(ticket), external, provider });
    } catch (err) {
        if (err instanceof AlreadyCoupledError) {
            return res.status(409).json({ error: err.message, existing_ticket_id: err.existingTicketId });
        }
        return badRequest(res, err instanceof Error ? err.message : String(err));
    }
});

/**
 * Upstream coupling phase 2 — Slice 1: manual export. Create a NEW external
 * issue from an existing aiball ticket and couple it. WRITES to the remote —
 * surfaces gate it behind an explicit confirmation. Body: { kind?, repo? }.
 */
ticketsRouter.post("/tickets/:id/export", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "ticket id required");
    const body = (req.body ?? {}) as { kind?: string; repo?: string; by_agent?: string };
    const by_agent = body.by_agent || consumerOf(req);
    try {
        const { ticket, external, provider } = await exportUpstream({
            ticket_id: id,
            kind: body.kind,
            repo: body.repo,
            by_agent,
        });
        return res.status(201).json({ ticket: withTagsOne(ticket), external, provider });
    } catch (err) {
        if (err instanceof AlreadyCoupledError) {
            return res.status(409).json({ error: err.message, existing_ticket_id: err.existingTicketId });
        }
        return badRequest(res, err instanceof Error ? err.message : String(err));
    }
});

ticketsRouter.get("/tickets/:id/relations", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    res.json({ ticket_id: id, relations: listTypedRelationsForTicket(id), ticket: ticketStateAfter(id, consumerOf(req)) });
});

/**
 * #2383 — mark a ticket as a step from the ticket itself (a button in the
 * thread, a bulk action in the list). It tags the ticket's LATEST comment,
 * which must be an agent's, as a step — the tagging itself is #2369's.
 * Refused when the thread's last word is a human's: only the last action
 * decides whose pool the ticket sits in, so tagging an older comment would
 * change nothing.
 */
ticketsRouter.post("/tickets/:id/step", (req: Request, res: Response) => ticketStepRoute(req, res, true));
ticketsRouter.post("/tickets/:id/unstep", (req: Request, res: Response) => ticketStepRoute(req, res, false));

function ticketStepRoute(req: Request, res: Response, tag: boolean) {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "ticket id required");
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({ error: "only a registered human moderator can mark a ticket as a step" });
    }
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    let latest: ReturnType<typeof getMessage> = null;
    for (const m of listMessages({ kind: "comment_added", ticket_id: id })) {
        if (m.status !== "approved") continue;
        if (!latest || m.id > latest.id) latest = m;
    }
    if (!latest) {
        return res.status(409).json({ error: "this ticket has no comment to mark as a step" });
    }
    if (!latest.by_agent || isHuman(latest.by_agent)) {
        return res.status(409).json({
            error: "the thread's last word is a human's — tagging an older comment would not move the ticket; answer the agent, or tag its own comment in the thread",
        });
    }
    try {
        const updated = tag ? tagMessageAsStep(latest.id, caller) : untagMessageStep(latest.id);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
}

ticketsRouter.post("/tickets/:id/relations", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const body = (req.body ?? {}) as { target_ticket_id?: number; kind?: string; axis_kind?: string };
    const target = Number(body.target_ticket_id);
    if (!Number.isFinite(target) || target <= 0) {
        return res.status(400).json({ error: "target_ticket_id required (positive integer)" });
    }
    if (target === id) {
        return res.status(400).json({ error: "a ticket cannot relate to itself" });
    }
    const kindStr = typeof body.kind === "string" ? body.kind : "";
    if (!isRelationKind(kindStr)) {
        return res.status(400).json({
            error: `kind must be one of ${RELATION_KINDS.join(", ")}`,
        });
    }
    const targetTicket = getMessage(target);
    if (!targetTicket || targetTicket.kind !== "ticket_created") {
        return res.status(404).json({ error: `target ticket #${target} not found` });
    }
    const caller = consumerOf(req);
    // Permission (#275): mirror the edit/snooze gate (isHuman bypass +
    // reporter), but accept the reporter of EITHER end — a relation links
    // two tickets, and standing on one of them is enough to attach the
    // other (e.g. file your own ticket as child_of someone else's). Human
    // moderators bypass entirely; the UI is human-driven, so this doesn't
    // change its behaviour.
    // #820 david `39nh52` : project-owner of EITHER project also passes.
    // Le owner d'un projet voit tout, doit pouvoir lier ses tickets aux
    // tickets cross-projet sans demander à david de poser à la main.
    // Relation reste informative ; abus → l'autre end peut delete via la
    // route DELETE existante.
    const callerIsProjectOwner =
        listProjectSubscribers(t.project, { roles: ["owner"] }).includes(caller)
        || listProjectSubscribers(targetTicket.project, { roles: ["owner"] }).includes(caller);
    // #2368 — the agent either ticket is assigned to may set or cut the
    // dependency gate between them: a relation is how the holder says its ticket
    // waits on another. (A claimant needs no rule of its own: only an owner of
    // the project can claim, and owners already pass.) Only that axis — lineage
    // and cross-references stay with the reporters and owners.
    const GATE_KINDS = ["depends_on", "blocks"];
    const touchesGateOnly = GATE_KINDS.includes(kindStr)
        || (kindStr === "ignored" && typeof body.axis_kind === "string" && GATE_KINDS.includes(body.axis_kind));
    const callerIsAssignee = t.assignee === caller || targetTicket.assignee === caller;
    if (
        !isHuman(caller) &&
        t.by_agent !== caller &&
        targetTicket.by_agent !== caller &&
        !callerIsProjectOwner &&
        !(touchesGateOnly && callerIsAssignee)
    ) {
        return res.status(403).json({
            error: `only a registered human moderator, the reporter of #${id} (${t.by_agent}) / #${target} (${targetTicket.by_agent}), a project-owner of either project, or (for depends_on / blocks) the agent either ticket is assigned to can relate them`,
        });
    }
    // Anti-cycle (#275): lineage (child_of/parent_of) must stay a DAG.
    // Reject an edge that would close a loop. parent_of is the mirror of
    // child_of, so swap (child, parent) for the check.
    if (kindStr === "child_of" && lineageWouldCycle(id, target)) {
        return res.status(409).json({
            error: `#${id} child_of #${target} would create a lineage cycle`,
        });
    }
    if (kindStr === "parent_of" && lineageWouldCycle(target, id)) {
        return res.status(409).json({
            error: `#${id} parent_of #${target} would create a lineage cycle`,
        });
    }
    // #1468 — an `ignored` tombstone may be scoped to ONE axis via `axis_kind`
    // (the kind whose axis to remove: `depends_on` cuts the gate, leaving a
    // `parent_of` lineage to the same target alive). Omitted = the historical
    // target-scoped cut that removes every axis.
    const axisKindStr = typeof body.axis_kind === "string" ? body.axis_kind : "";
    if (axisKindStr && !isRelationKind(axisKindStr)) {
        return res.status(400).json({
            error: `axis_kind must be one of ${RELATION_KINDS.join(", ")}`,
        });
    }
    if (axisKindStr && kindStr !== "ignored") {
        return res.status(400).json({
            error: "axis_kind only applies when removing a relation (kind=ignored)",
        });
    }
    const cutAxis = axisKindStr ? relationAxis(axisKindStr as RelationKind) : undefined;
    // Idempotency (#275): at most one active edge per (source, target, axis).
    // Re-posting the same active kind, or removing (ignored) an edge that
    // isn't there, is a no-op — don't append a redundant event.
    const before = listTypedRelationsForTicket(id);
    if (kindStr === "ignored") {
        // Axis-scoped: only a relation on THAT axis counts as something to cut.
        const hit = cutAxis
            ? before.some((r) => r.target_ticket_id === target && relationAxis(r.kind) === cutAxis)
            : before.some((r) => r.target_ticket_id === target);
        if (!hit) {
            return res.json({ ticket_id: id, event_id: null, noop: true, relations: before });
        }
    } else if (before.some((r) => r.target_ticket_id === target && r.kind === kindStr)) {
        const dup = before.find((r) => r.target_ticket_id === target && r.kind === kindStr)!;
        return res.json({ ticket_id: id, event_id: dup.last_event_id, noop: true, relations: before });
    }
    const event = insertTypedRelation({
        source_ticket_id: id,
        target_ticket_id: target,
        relation_kind: kindStr as RelationKind,
        by_agent: caller,
        axis: cutAxis,
    });
    if (!event) return res.status(500).json({ error: "failed to create relation event" });
    broadcast({ type: "message_created", data: event });
    res.json({
        ticket_id: id,
        event_id: event.id,
        relations: listTypedRelationsForTicket(id),
    });
});

ticketsRouter.get("/tickets/:id", (req, res) => {
    // The :id param accepts either:
    //   - an integer ticket id (#B<id>) → resolved directly,
    //   - an integer comment id (legacy #C<id>) → resolved to parent thread
    //     with focus_message_id set,
    //   - a 6-char hashid string (canonical #C<hashid>) → looked up by
    //     hashid then resolved like an integer comment.
    const raw = req.params.id;
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    let requested: Message | null = null;
    if (numeric !== null) {
        requested = getMessage(numeric);
    }
    if (!requested) {
        requested = getMessageByHashid(raw);
    }
    if (!requested) return notFound(res, "ticket not found");
    // If the id is a comment (or close/reopen event), resolve up to its
    // parent ticket and attach `focus_message_id` so the UI can scroll to
    // the right place. Lets `#N` references in markdown be opened blindly.
    let t = requested;
    let focusMessageId: number | null = null;
    if (t.kind !== "ticket_created") {
        if (!t.ticket_id) return notFound(res, "ticket not found");
        const parent = getMessage(t.ticket_id);
        if (!parent || parent.kind !== "ticket_created") {
            return notFound(res, "ticket not found");
        }
        focusMessageId = requested.id;
        t = parent;
    }
    const id = t.id;
    // Return tickets in any status so the moderator can open pending or
    // rejected ones from the inbox and act on them inline.
    // #2171 — narrow to THIS thread. Without the ticket id this loaded every
    // message of the project (6014 on aiball) and filtered in JS down to the
    // handful below, so the header-only probe — the mode documented as the
    // CHEAP one — cost exactly what the full thread cost: 144 ms either way.
    // The filter already existed; #2159 added it so the inbox aggregate could
    // rebuild one entry, and this route never picked it up. 144 ms -> 11 ms.
    const all = listMessages({ project: t.project, ticket_id: id });
    // Thread feed = comments + lifecycle events, inline. Lifecycle events
    // (close / reopen / resolved) are rendered as system rows in the UI so
    // the reader can see who flipped the state and when. Order: ASC by id.
    // #309: the UI opts into seeing user-deleted comments (as tombstones)
    // via ?include_deleted=1; default (and every MCP read) never sees them.
    const includeDeleted = req.query.include_deleted === "1";
    const threadMessages = all
        .filter(
            (m) =>
                m.ticket_id === id &&
                (m.kind === "comment_added" ||
                    m.kind === "ticket_closed" ||
                    m.kind === "ticket_reopened" ||
                    m.kind === "ticket_resolved" ||
                    m.kind === "ticket_blocked" ||
                    m.kind === "ticket_sub_added" ||
                    m.kind === "ticket_referenced" ||
                    m.kind === "dependency_closed" ||
                    m.kind === "related_closed" ||
                    m.kind === "dependency_rejected" ||
                    m.kind === "ticket_relation") &&
                // rejected rows are hidden — EXCEPT user-deletions (#309): a
                // comment with meta.deleted is re-surfaced as a tombstone, but
                // only when the UI explicitly asks (include_deleted).
                (m.status !== "rejected" ||
                    (includeDeleted &&
                        m.kind === "comment_added" &&
                        !!parseMeta(m.meta ?? null).deleted)) &&
                // #271: lineage relations (child_of/parent_of) are surfaced
                // as chips in the relations cartouche; the ticket_sub_added
                // pseudo already logs the link in the timeline, so drop the
                // parallel relation event here to avoid a redundant row.
                !(m.kind === "ticket_relation" &&
                    isLineageRelationKind(parseMeta(m.meta ?? null).relation?.kind ?? "")),
        )
        .sort((a, b) => a.id - b.id);
    // Lifecycle replay restricted to approved events for the header
    // flags. Since #B.129 phase 2, a comment_added with `meta.decision
    // .kind=="resolution"` and decision.status=="accepted" is replayed
    // as a synthetic ticket_resolved event at the comment's id, so
    // historical (legacy ticket_resolved kind) AND new (comment+decision)
    // shapes converge in the same replay.
    const lifecycle: Message[] = [];
    for (const m of threadMessages) {
        if (m.status !== "approved") continue;
        if (m.kind === "comment_added") {
            const d = parseMeta(m.meta ?? null).decision;
            if (d && resolvesTicket(d.kind, d.status)) {
                lifecycle.push({
                    ...m,
                    kind: "ticket_resolved",
                    by_agent: d.decided_by ?? m.by_agent,
                    created_at: d.decided_at ?? m.created_at,
                });
            }
            continue;
        }
        lifecycle.push(m);
    }
    lifecycle.sort((a, b) => a.id - b.id);
    let closedFlag = false;
    let resolvedFlag = false;
    let resolvedBy: string | null = null;
    let resolvedAt: string | null = null;
    let blockedFlag = false;
    let blockedBy: string | null = null;
    let blockedAt: string | null = null;
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") closedFlag = true;
        else if (ev.kind === "ticket_reopened") {
            closedFlag = false;
            resolvedFlag = false;
            resolvedBy = null;
            resolvedAt = null;
            blockedFlag = false;
            blockedBy = null;
            blockedAt = null;
        } else if (ev.kind === "ticket_resolved") {
            resolvedFlag = true;
            resolvedBy = ev.by_agent;
            resolvedAt = ev.created_at;
        } else if (ev.kind === "ticket_blocked") {
            blockedFlag = true;
            blockedBy = ev.by_agent;
            blockedAt = ev.created_at;
        }
    }
    const closed = closedFlag || t.status === "rejected";
    // resolved stays true even after the ticket is closed — the UI uses the
    // pair (closed, resolved) to distinguish "closed because resolved" from
    // "closed without explicit resolution" (wontfix / abandoned / dup).
    // Reopen still zeroes resolvedFlag inside the replay loop.
    const resolved = resolvedFlag;
    // Same idea for blocked (#B.119): persists past close so the UI can
    // still tell "closed after agent escalation" from a normal resolve.
    const blocked = blockedFlag;
    // Verbosity (#B.87 palier 2): default is summary now — header only,
    // no body, no comments array. Pass `full=1` to opt back into the
    // full thread. Old `summary=0` accepted as the explicit override
    // for symmetry with /api/tickets. `brief=1` and `digest=1` both
    // imply the thread shape too — opting into one of them means the
    // caller wants the reshaped read, not the bare header.
    const fullThread =
        req.query.full === "1" ||
        req.query.summary === "0" ||
        req.query.brief === "1" ||
        req.query.digest === "1";
    const summary = !fullThread;
    // #1350 — per-consumer `actionable`/`claimable` on the single-ticket
    // header, mirroring the list-row flags (see ~644-673). The wake renderer
    // reads `claimable` on the head event's ticket to decide the
    // "(fyi — action is not mandatory)" suffix: a subscriber who is not the
    // responsible maintainer (non-claimable) gets an info wake, not a triage
    // push. Same helper + same owned-projects/can-claim gate as the list, so
    // the two views can never disagree.
    const flagConsumer = consumerOf(req);
    // #2102 — one ticket's header asks about one ticket.
    const { actionableIds: hdrActionableIds } = computeActionableTicketIds(flagConsumer, [t.id]);
    const hdrOwnedProjects = new Set(
        listSubscriptions(flagConsumer)
            .filter((s) => s.role === "owner")
            .map((s) => s.project),
    );
    const hdrConsumerRow = getConsumer(flagConsumer);
    const hdrCanClaim =
        (!hdrConsumerRow || hdrConsumerRow.can_claim !== false) &&
        (req as AuthenticatedRequest).no_claim_hint !== true;
    const hdrActionable = hdrActionableIds.has(t.id);
    const hdrClaimable = hdrCanClaim
        ? hdrActionable && hdrOwnedProjects.has(t.project)
        : t.assignee === flagConsumer && hdrActionable;
    const headerBase = {
        id: t.id,
        project: t.project,
        title: t.title,
        summary: t.summary ?? null,
        by_agent: t.by_agent,
        created_at: t.created_at,
        status: t.status,
        closed,
        resolved,
        resolved_by: resolved ? resolvedBy : null,
        resolved_at: resolved ? resolvedAt : null,
        blocked,
        blocked_by: blocked ? blockedBy : null,
        blocked_at: blocked ? blockedAt : null,
        scope: t.scope,
        postponed_until: t.postponed_until ?? null,
        intent: t.intent,
        priority: t.priority ?? "normal",
        // #418/#436: assignment (responsibility) + claim (focus) — distinct
        // fields, surfaced on the thread header so the UI renders "assigned to X"
        // and/or "claimed by Y". `is_claim` kept for back-compat (claimed?).
        assignee: t.assignee ?? null,
        assigned_by: t.assigned_by ?? null,
        assigned_at: t.assigned_at ?? null,
        claimant: t.claimant ?? null,
        claimed_at: t.claimed_at ?? null,
        is_claim: t.claimant != null,
        parent_ticket_id: t.parent_ticket_id ?? null,
        sub_tickets: listSubTickets(t.id),
        tags: listMessageTags(t.id),
        // #B.104: sidecar metadata (question-answer audit, etc.).
        // Frontend reads this to render the "X/Y open" chip beside
        // questions without round-tripping to the server.
        meta: t.meta ?? null,
        // #406 (david 7mybeg "dans le détail ticket on a pas l'info du cumul
        // d'effort"): expose the per-ticket token tally on the GET header too,
        // not just list rows — the thread badge (ThreadHeader) reads it, and the
        // detail view fetches via ticket_get, so without this the badge had no
        // data when a ticket was opened directly. null until any usage captured.
        token_usage: getTicketTokenUsage([t.id]).get(t.id) ?? null,
        // #569 david `j8t4qa` A+C : flag explicite que l'agent peut tester
        // AVANT de poster un `ticket_reply then:"resolved"` / `then:"plan"`.
        // True ssi le ticket est `status: "approved"`. Faux sur pending /
        // rejected — l'API renverra de toute façon HTTP 409
        // (PARENT_PENDING_MODERATION) si l'agent tente, mais le flag
        // est plus pédagogique : l'agent lit le ticket → voit le flag →
        // décide d'attendre / d'asker un plain comment.
        decision_proposable: t.status === "approved",
        // #2112 david: "si pas de payload doit être complètement invisible".
        // Invisible means the UI must not even ASK — a `GET …/payload` on every
        // thread open, answered 404 for all but a handful of tickets, is a
        // round-trip and a log line for nothing. This flag lets the panel stay
        // unmounted rather than merely render empty. It says a payload EXISTS,
        // never anything about what is in it.
        has_payload: ticketHasPayload(t.id),
        // #596 david `sa44wy` : ≥1 unseen ping on this thread for the
        // requesting consumer. Frontend uses it to skip the
        // "marking-as-read" pulse when landing on an already-read ticket.
        unread: ticketUnreadFlags(consumerOf(req), [t.id]).get(t.id) ?? false,
        // #1350 — per-consumer work-landscape flags, same semantics as the
        // list rows. `claimable` is the wake renderer's discriminator for the
        // info-vs-triage suffix on event wakes.
        actionable: hdrActionable,
        claimable: hdrClaimable,
        // #928 david `2uxj45` (Slice 1) : ta dernière décision postée sur
        // ce ticket (then:plan / then:resolved / then:wontfix /
        // then:escalate) — surface l'état pending/accepted/rejected en
        // header. Évite à l'agent de drill dans comments[].meta.decision
        // pour savoir "où en est ma décision" (cf. bug #951 où j'avais
        // claim "pending" alors qu'accepted). null = aucune décision
        // posée par ce consumer sur ce ticket.
        your_latest_decision: (() => {
            const consumer = consumerOf(req);
            let latest: { kind: string; status: string; hashid: string | null; decided_at: string | null } | null = null;
            let latestId = -1;
            for (const m of threadMessages) {
                if (m.kind !== "comment_added") continue;
                if (m.by_agent !== consumer) continue;
                if (m.status === "rejected") continue;
                const dec = parseMeta(m.meta ?? null).decision;
                if (!dec || !dec.kind || !dec.status) continue;
                if (m.id > latestId) {
                    latestId = m.id;
                    latest = {
                        kind: dec.kind,
                        status: dec.status,
                        hashid: m.hashid ?? null,
                        decided_at: dec.decided_at ?? null,
                    };
                }
            }
            return latest;
        })(),
    };
    if (summary) {
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return res.json({
            ticket: headerBase,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        });
    }
    // #B.130 phase 2: brief mode. Reshapes the thread to drop the
    // already-summarized prefix and ship only the canonical pivot
    // line + everything after it.
    //
    // #B.21X (this change): pivot-cut. Scan approved comment_added
    // from newest → oldest, find the first one carrying
    // meta.summary_until — that's the pivot. The pivot's contract
    // ("ticket state AFTER this comment") makes it strictly lossless
    // to drop every earlier comment_added: they're all captured in
    // that one line. The pivot ships with body stripped (summary_until
    // IS its body); every comment_added AFTER the pivot keeps its
    // full body (that's the active "now" the reader needs).
    //
    // Lifecycle events (closed / reopened / resolved / blocked /
    // sub-added / referenced / relation) are always kept regardless
    // of position — they're small, semantically distinct, and not
    // covered by summary_until.
    //
    // Fallback: if no comment in the thread carries summary_until
    // (legacy threads, pure-human threads), revert to the legacy
    // tail-based brief — keep the last `tail` bodies intact, collapse
    // older comments with summary_until-when-present, keep bodies
    // otherwise. So brief is never lossy-by-absence.
    //
    // #B.21X (this change): digest mode. `digest: true` returns the
    // header plus an ordered `digest[]` of the thread's summary_until
    // snapshots — bird's-eye progression for cross-ticket scans.
    // Optional `digest_limit=N` trims to the last N snapshots. Ignored
    // when full or brief is set.
    const brief = req.query.brief === "1";
    const digest = req.query.digest === "1";
    if (digest && !brief) {
        const limitRaw = req.query.digest_limit;
        const limitParsed = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : NaN;
        const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? limitParsed : null;
        const snapshots = threadMessages
            .filter((m) => m.kind === "comment_added" && m.status === "approved")
            .map((m) => {
                const su = parseMeta(m.meta ?? null).summary_until;
                if (!su) return null;
                return {
                    id: m.id,
                    hashid: m.hashid,
                    by_agent: m.by_agent,
                    created_at: m.created_at,
                    summary_until: su,
                };
            })
            .filter((x): x is { id: number; hashid: string | null; by_agent: string; created_at: string; summary_until: string } => x !== null);
        const trimmed = limit !== null ? snapshots.slice(-limit) : snapshots;
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return res.json({
            ticket: headerBase,
            digest: trimmed,
            digest_limit: limit ?? undefined,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        });
    }
    // #B.202: `tail=N` survives for the no-pivot fallback path. When
    // a pivot is found, tail is a no-op (the cut is semantic, not
    // positional).
    const tailRaw = req.query.tail;
    const tailParsed = typeof tailRaw === "string" ? Number.parseInt(tailRaw, 10) : NaN;
    const tail = Number.isFinite(tailParsed) && tailParsed > 0 ? tailParsed : 1;
    // #518 — décorer avec votes_summary (up/down + viewer's mine). Le viewer
    // est consumerOf(req) : chaque user voit son `mine` calculé pour lui.
    let outComments = enrichRelationStages(withVotes(withTags(threadMessages), consumerOf(req)));
    let pivotCommentId: number | null = null;
    let pivotApplied = false;
    if (brief) {
        for (const m of [...threadMessages].reverse()) {
            if (m.kind !== "comment_added" || m.status !== "approved") continue;
            const su = parseMeta(m.meta ?? null).summary_until;
            if (su) {
                pivotCommentId = m.id;
                break;
            }
        }
        if (pivotCommentId !== null) {
            pivotApplied = true;
            const cutId = pivotCommentId;
            outComments = outComments
                .filter((m) => m.kind !== "comment_added" || m.id >= cutId)
                .map((m) => {
                    if (m.kind !== "comment_added") return m;
                    const su = parseMeta(m.meta ?? null).summary_until ?? null;
                    if (m.id === cutId) {
                        return { ...m, body: null, summary_until: su } as typeof m;
                    }
                    return { ...m, summary_until: su } as typeof m;
                });
        } else {
            const keepIds = new Set<number>();
            const approvedIds = threadMessages
                .filter((m) => m.kind === "comment_added" && m.status === "approved")
                .map((m) => m.id)
                .sort((a, b) => b - a)
                .slice(0, tail);
            for (const id of approvedIds) keepIds.add(id);
            outComments = outComments.map((m) => {
                if (m.kind !== "comment_added" || keepIds.has(m.id)) return m;
                const meta = parseMeta(m.meta ?? null);
                const summaryUntil = meta.summary_until ?? null;
                if (!summaryUntil) {
                    return { ...m, summary_until: null } as typeof m;
                }
                return { ...m, body: null, summary_until: summaryUntil } as typeof m;
            });
        }
    }
    // #309: user-deleted comments (only present when include_deleted=1) ship
    // as tombstones — strip the body so the UI shows a placeholder, never the
    // original text. `meta.deleted` stays so the frontend renders the marker.
    outComments = outComments.map((m) =>
        m.kind === "comment_added" && parseMeta(m.meta ?? null).deleted
            ? ({ ...m, body: null } as typeof m)
            : m,
    );
    // #396 (david h4gp5z): paginate + order the full thread feed. Lets a reader
    // page through a big thread — or grab the last N entries WITH full bodies —
    // instead of pulling the whole 80 KB at once. Only in pure full mode (brief
    // and digest have their own shapes). Pure logic in feed-paginate.ts.
    let pagination: FeedPagination | undefined;
    if (!brief) {
        const paged = paginateFeed(outComments, {
            offset: req.query.offset,
            limit: req.query.limit,
            order: req.query.order,
        });
        outComments = paged.feed;
        pagination = paged.pagination;
    }
    // #B.123 phase B: surface the active typed relations alongside the
    // existing parent/sub-ticket lineage. Each relation is enriched
    // with the target ticket's lifecycle stage (open / closed /
    // closed-resolved / rejected) so the chip can render a state
    // badge — david: "dans la nouvelle présentation on voit plus
    // l'état du ticket en relation".
    const typedRelations = listTypedRelationsForTicket(id);
    const targetStages = typedRelations.length > 0
        ? getTicketStages(typedRelations.map((r) => r.target_ticket_id))
        : new Map<number, string>();
    const typedRelationsWithStage = typedRelations.map((r) => ({
        ...r,
        target_stage: targetStages.get(r.target_ticket_id) ?? "open",
    }));
    // #283: resolve `/uploads/<sha>.<ext>` refs in the bodies we're about to
    // ship into ready-to-open attachments, so a cold-start agent doesn't have
    // to reverse-engineer where the file lives on disk. `local` is true only
    // for same-host (UDS / local-trust) callers — then `uri` is a `file://`
    // path; remote/browser callers get the HTTP ref. Only scan the bodies
    // actually present in the response (brief mode collapses pre-pivot ones).
    const ticketBody = t.body;
    const localTrust =
        (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const attachments = resolveAttachments(
        [ticketBody, ...outComments.map((c) => c.body)],
        localTrust,
    );
    res.json({
        ticket: {
            ...headerBase,
            body: ticketBody,
            relations: typedRelationsWithStage,
        },
        comments: outComments,
        attachments,
        focus_message_id: focusMessageId,
        brief,
        // `pivot_comment_id` surfaces the cut point when brief mode
        // applied the pivot-cut. Null when brief fell back to the
        // legacy tail-keep (no summary_until in thread). `tail` is
        // only relevant in that fallback path.
        pivot_comment_id: brief ? pivotCommentId : undefined,
        tail: brief && !pivotApplied ? tail : undefined,
        // #396: present only when the full feed was paginated/reordered.
        pagination,
    });
});

/**
 * Decorate ticket_referenced / ticket_sub_added pseudo-comments with the
 * `source_ticket_stage` of their target so the UI can render a small
 * state badge next to the ref (per #B.70 follow-up). Batched: one
 * lookup for every distinct source_ticket_id in the thread.
 */
const RELATION_CHIP_KINDS = new Set([
    "ticket_referenced", "ticket_sub_added", "dependency_closed", "related_closed", "dependency_rejected",
]);
const isRelationChipKind = (kind: string): boolean => RELATION_CHIP_KINDS.has(kind);

function enrichRelationStages<T extends { id: number; kind: string; source_ticket_id?: number | null }>(comments: T[]): (T & { source_ticket_stage?: string })[] {
    const sourceIds = new Set<number>();
    for (const c of comments) {
        if (isRelationChipKind(c.kind) && typeof c.source_ticket_id === "number") {
            sourceIds.add(c.source_ticket_id);
        }
    }
    if (sourceIds.size === 0) return comments;
    const stages = getTicketStages([...sourceIds]);
    return comments.map((c) => {
        if (isRelationChipKind(c.kind) && typeof c.source_ticket_id === "number") {
            return { ...c, source_ticket_stage: stages.get(c.source_ticket_id) ?? "open" };
        }
        return c;
    });
}
