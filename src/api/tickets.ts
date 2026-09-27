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
import { serveMethod } from "../bus/http.js";
import { waitCreditBalance, waitCreditEnabled, waitCreditRules } from "../db/wait-credit.js";
import { milestoneRankOf, milestonesOf } from "../db/milestones.js";
import { Router, type Request } from "express";
import {
    listMessages,
    tagsForMessages,
    subTicketCounts,
    getTicketStages,
    getTicketTitles,
    getMessage,
    ticketUnreadFlags,
    ticketAgentLastActivity,
    ticketOthersLastActivity,
    getTicketTokenUsage,
    isHuman,
    ticketSelfLastActivity,
    getConsumer,
} from "../db.js";
import { computeActionableTicketIds } from "../db/projects.js";
import { computeTicketFlags, buildTicketFlagsContext } from "../db/ticket-flags.js";
import { listSubscriptions } from "../db/subscriptions.js";
import { isAssignmentLive } from "../db/assignment-gate.js";
import { compareWorkOrder, computeHotFocus, type WorkOrderCtx } from "../db/work-order.js";
import { assignWindowSec } from "../autopoll/config.js";

import { buildInboxRow, buildInboxRowContext, hotWindowSec } from "./inbox-row.js";
import { getInboxAgg, isLiveDecision, liveStep, type LiveStep } from "../db/inbox-agg.js";
import { DECISION_KINDS } from "../decisions.js";

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
export function ticketStateAfter(id: number, consumerId: string) {
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return null;
    return buildInboxRow(t, buildInboxRowContext([t], consumerId, t.project));
}

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
ticketsRouter.post("/tickets/:id/owner", serveMethod("ticket.set_owner"));

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
/** #2379 — when the claim of `holder` stops protecting this ticket (epoch ms), or null. */

ticketsRouter.post("/tickets/:id/assign", serveMethod("ticket.assign"));

/**
 * #418: release a ticket's assignment / claim — back to the shared pool. The
 * current assignee or a human moderator can release.
 */
ticketsRouter.post("/tickets/:id/release", serveMethod("ticket.release"));

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
ticketsRouter.post("/tickets/:id/token-usage", serveMethod("ticket.add_token_usage"));

/**
 * #352: list a ticket's EXPLICIT subscriptions (follows + mutes), for the
 * moderator's inline manage panel. Moderator-only — it manages who else gets
 * pinged. Owners pinged by project role aren't listed (explicit-only, david).
 */
ticketsRouter.get("/tickets/:id/subscriptions", serveMethod("ticket.subscribers"));
/**
 * Inbox bookends: oldest + newest non-rejected ticket matching the
 * scope. Used by the slim `poll()` (per #B.68) so agents see the
 * inbox edges without paying for the full subscriptions/projects blob.
 *
 * Query:
 *   - project=NAME    (optional) restrict to a project; otherwise cross-project.
 *   - include_snoozed=1  include snoozed tickets in the scope.
 */
ticketsRouter.get("/tickets/bookends", serveMethod("ticket.bookends"));

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
export const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

ticketsRouter.get("/inbox", serveMethod("inbox.list", undefined, {
    // #2071 — the total in a header, the body a plain array: what HTTP clients read.
    respond: (res, out) => {
        const { total, rows } = out as { total: number; rows: unknown[] };
        res.setHeader("X-Total-Count", String(total));
        res.json(rows);
    },
}));

/**
 * #3031 — the ticket list as `agentId` sees it: the whole computation of
 * `GET /api/tickets`, with the agent a parameter instead of the caller. The
 * route passes the caller; `GET /api/consumers/:id/backlog` passes the agent a
 * moderator is watching, so reading another agent's view no longer means
 * sending its identity. `noClaimHint` is the proxy node's no-claim header
 * (`x-aiball-no-claim`), which only a caller's own request carries.
 * Read-only: it marks nothing read and records no wake.
 */
export function listTicketsFor(agentId: string, query: Request["query"], opts: { noClaimHint: boolean }): unknown {
    const project = query.project as string | undefined;
    const onlyOpen = query.open === "1";
    // #B.232 #234 david: actionable=1 is a stricter form of open=1
    // that ALSO excludes resolved-pending, blocked, and gated tickets
    // (mirrors actionable_count semantics on the sidebar). Used by the
    // wake-CTA so the agent's candidate pool excludes tickets already
    // in awaiting-validation state. Frontend keeps open=1 for the
    // broader "everything not lifecycle-closed" view (david still needs
    // to see resolution proposals to act on them).
    const onlyActionable = query.actionable === "1";
    // #432 david: `claimable` is a DIFFERENT, narrower lens than `actionable`.
    // actionable stays inclusive (a follower-broadcast from another project is
    // still actionable/visible); claimable = actionable ∩ {projects where THIS
    // consumer is an `owner`}. Claiming commits you to the work, which belongs
    // to that project's owners — so a project you only `follow` is actionable
    // but not claimable. `ticket_claim` + the wake-CTA head use this set.
    const onlyClaimable = query.claimable === "1";
    // The backlog wake set: actionable tickets (ball in my court) UNION
    // open tickets where I was the last actor (ball in their court). Tier
    // 1 sorts first via the existing work-order tiering — actionable
    // collapses into its tier, the others land in "other open".
    // See docs/TICKET_LIFECYCLE.md §5.0.
    const onlyBacklog = query.backlog === "1";
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
    const assumeDrained = query.assume_drained === "1";
    // Default: when `open=1`, snoozed tickets are hidden (same rule as
    // the inbox). Pass `include_postponed=1` to surface them anyway.
    const includePostponed = query.include_postponed === "1";
    // Tag filter — comma-separated names. AND semantics: a ticket must
    // carry EVERY listed tag to match. Unknown tag names are ignored
    // silently rather than 400'ing — keeps the URL lenient.
    const tagsFilter = typeof query.tags === "string"
        ? query.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    // Verbosity (#B.83 then #B.87 palier 2): default is summary now —
    // header-only payload, no body. Pass `full=1` to
    // re-include bodies. `summary=1` kept as an accepted alias for
    // explicit-summary requests; `summary=0` forces full. The plain
    // default (neither flag) is summary.
    const fullParam = query.full;
    const summaryParam = query.summary;
    const summary =
        fullParam === "1"
            ? false
            : summaryParam === "0"
              ? false
              : true;
    // Author filter (#B.84): scope to tickets posted by a specific
    // consumer_id. Useful for "my tickets" without scanning the full list.
    const byAgent = typeof query.by_agent === "string" && query.by_agent
        ? query.by_agent
        : undefined;
    // Status filter (#B.84): default "approved" preserves prior behavior;
    // pass "pending" / "rejected" / "any" to widen.
    const statusParam = (query.status as string | undefined) ?? "approved";
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
        typeof query.title_contains === "string" && query.title_contains
            ? query.title_contains.toLowerCase()
            : undefined;
    const limit =
        typeof query.limit === "string" && Number.isFinite(Number(query.limit))
            ? Math.max(1, Math.min(500, Number(query.limit)))
            : undefined;
    // #2910 — only the tickets of this milestone.
    const milestoneFilter =
        typeof query.milestone === "string" && Number.isInteger(Number(query.milestone)) && Number(query.milestone) > 0
            ? Number(query.milestone)
            : undefined;
    // since (#B.87): filter on ticket created_at >= since. Accepts any
    // string Date.parse() understands (ISO8601 recommended). Cheap
    // alternative to client-side diff when polling for new tickets.
    const sinceParam = typeof query.since === "string" ? query.since : undefined;
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
    const consumerId = agentId;
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
    const proxyHint = opts.noClaimHint;
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
    // #2682 — a closed ticket is never in the backlog (the `closed` rule
    // excludes it from `backlog-tier`, against this very `closedSet`), so the
    // backlog path does not pay flags for it. On aiball that is most of the
    // project: the loops ask for this on every wake attempt.
    // #3000 — without a page, the cheap filters (open, actionable, title,
    // since) still run BEFORE the flags are built: they are decidable on the
    // raw rows and applied again below, so the result is the same. `open=1` on
    // aiball built flags for ~1200 tickets to keep ~50, at ~0.4 s a call.
    const buildFrom = pageCreated ?? (() => {
        const cand = cheapCandidates();
        return onlyBacklog ? cand.filter((m) => !closedSet.has(m.id)) : cand;
    })();
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
    const cooldownSec = typeof query.cooldown_sec === "string"
        && Number.isFinite(Number(query.cooldown_sec))
        ? Math.max(0, Number(query.cooldown_sec))
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
    // #2765 — and the live step, from the same aggregate as the UI row.
    const stepByTicket = new Map<number, LiveStep>();
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
            const step = liveStep(agg, m.status !== "rejected");
            if (step) stepByTicket.set(m.id, step);
            for (const kind of DECISION_KINDS) {
                if (agg.decisions[kind].pending && isLiveDecision(agg, kind)) {
                    pendingDecisionIds.add(m.id);
                    break;
                }
            }
        }
    }
    // #2640 — the asking agent's wait credit on each row's project, so a
    // backlog wake can show it where the agent chooses its next wait.
    // #3000 — read once per project for the page: the config lookups behind
    // `waitCreditEnabled` / `waitCreditRules` ran for every row.
    const waitCredits = new Map<string, number | null>();
    const waitCreditOf = (project: string): number | null => {
        if (!waitCredits.has(project)) {
            waitCredits.set(project, !consumerId || isHuman(consumerId) || !waitCreditEnabled(project)
                ? null
                : waitCreditBalance(consumerId, project));
        }
        return waitCredits.get(project)!;
    };
    const waitRules = new Map<string, ReturnType<typeof waitCreditRules>>();
    const waitRulesOf = (project: string) => {
        if (!waitRules.has(project)) waitRules.set(project, waitCreditRules(project));
        return waitRules.get(project)!;
    };
    // #2910 — the milestone each row belongs to, read once for the page.
    const milestoneByTicket = milestonesOf(buildFrom.map((m) => m.id));
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
            // #2759 — spelled out: `status: "pending"` is easy to misread.
            awaiting_moderation: m.status === "pending",
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
            // #2770 — on the project's critical ticket: how many it holds back.
            critical: flags.critical,
            backlog_cooled_until: flags.backlog_cooled_until,
            backlog_last_wake_at: flags.backlog_last_wake_at,
            wait_credit_minutes: flags.backlog_tier !== null ? waitCreditOf(m.project) : null,
            wait_credit_rules: flags.backlog_tier !== null && waitCreditOf(m.project) !== null ? waitRulesOf(m.project) : null,
            gated_by_decision: flags.gated_by_decision,
            // #2376 david `a6zkyf` — a `then:` still waiting for its accept,
            // whether or not it gates the ticket: a human's comment hands the
            // ticket back to the agent while the proposal stays pending, and
            // what is then wanted is to confirm or amend it, not to re-triage.
            // The wake reads this to say so.
            pending_decision: pendingDecisionIds.has(m.id),
            // #2765 — the ticket's last word is a step: what it resumes on.
            step: stepByTicket.get(m.id) ?? null,
            // #2910 — the milestone this ticket belongs to.
            milestone: milestoneByTicket.get(m.id) ?? null,
            level: m.level ?? "task",
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
    if (milestoneFilter !== undefined) result = result.filter((t) => t.milestone?.id === milestoneFilter);
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
            // #2910 — at equal tier, the project's current milestone first,
            // then no milestone, then the later ones: a ticket queued for a
            // later release no longer comes up ahead of the current one.
            const rankOf = milestoneRankOf();
            result.sort((a, b) => {
                const ta = a.backlog_tier ?? 99;
                const tb = b.backlog_tier ?? 99;
                if (ta !== tb) return ta - tb;
                const ma = rankOf(a.project, a.milestone?.id);
                const mb = rankOf(b.project, b.milestone?.id);
                if (ma !== mb) return ma - mb;
                return compareWorkOrder(a, b, ctx);
            });
        } else {
            result.sort((a, b) => compareWorkOrder(a, b, ctx));
        }
    }
    if (limit !== undefined) result = result.slice(0, limit);
    return result;
}

ticketsRouter.get("/tickets", serveMethod("ticket.list"));

ticketsRouter.post("/tickets/:id/mark-read", serveMethod("ticket.mark_read"));

ticketsRouter.post("/tickets/:id/mark-unread", serveMethod("ticket.mark_unread"));
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
ticketsRouter.post("/tickets/:id/postpone", serveMethod("ticket.postpone"));

ticketsRouter.post("/tickets/:id/unsnooze", serveMethod("ticket.unsnooze"));

/**
 * Move a ticket (whole thread) to another project (#294). Reporter-or-human
 * only — same authority as postpone/close. The project lives only on the
 * head, so the move is a head update (project + fresh display_seq) plus an
 * in-thread audit comment; broadcast lets both project views update live.
 */
ticketsRouter.post("/tickets/:id/move", serveMethod("ticket.move"));

/**
 * #2180 — a ticket's pending children, one level, each with who attached it and
 * when. What the moderator reads before sweeping. A read, open like the other
 * ticket reads.
 */
ticketsRouter.get("/tickets/:id/pending-children", serveMethod("ticket.pending_children"));

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
ticketsRouter.post("/tickets/:id/approve-pending-children", serveMethod("ticket.approve_pending_children"));

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
ticketsRouter.post("/tickets/import", serveMethod("ticket.import", undefined, { status: 201 }));

/**
 * Upstream coupling phase 2 — Slice 1: manual export. Create a NEW external
 * issue from an existing aiball ticket and couple it. WRITES to the remote —
 * surfaces gate it behind an explicit confirmation. Body: { kind?, repo? }.
 */
ticketsRouter.post("/tickets/:id/export", serveMethod("ticket.export", undefined, { status: 201 }));

/**
 * #2383 — mark a ticket as a step from the ticket itself (a button in the
 * thread, a bulk action in the list). It tags the ticket's LATEST comment,
 * which must be an agent's, as a step — the tagging itself is #2369's.
 * Refused when the thread's last word is a human's: only the last action
 * decides whose pool the ticket sits in, so tagging an older comment would
 * change nothing.
 */
ticketsRouter.post("/tickets/:id/step", serveMethod("ticket.step"));
ticketsRouter.post("/tickets/:id/unstep", serveMethod("ticket.unstep"));

/**
 * #2910 — put a ticket in a milestone, move it to another, or take it out
 * (`milestone_id: null`). Planning: a human's gesture or a cto agent's (one that
 * works on the milestone level); a coder reads milestones but does not set them.
 */
ticketsRouter.post("/tickets/:id/milestone", serveMethod("ticket.set_milestone"));

ticketsRouter.post("/tickets/:id/relations", serveMethod("ticket.relate"));

ticketsRouter.get("/tickets/:id", serveMethod("ticket.get"));

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

export function enrichRelationStages<T extends { id: number; kind: string; source_ticket_id?: number | null }>(comments: T[]): (T & { source_ticket_stage?: string; source_ticket_title?: string | null })[] {
    const sourceIds = new Set<number>();
    for (const c of comments) {
        if (isRelationChipKind(c.kind) && typeof c.source_ticket_id === "number") {
            sourceIds.add(c.source_ticket_id);
        }
    }
    if (sourceIds.size === 0) return comments;
    const stages = getTicketStages([...sourceIds]);
    // #2432 — the rows name the other ticket by number; hovering says which.
    const titles = getTicketTitles([...sourceIds]);
    return comments.map((c) => {
        if (isRelationChipKind(c.kind) && typeof c.source_ticket_id === "number") {
            return {
                ...c,
                source_ticket_stage: stages.get(c.source_ticket_id) ?? "open",
                source_ticket_title: titles.get(c.source_ticket_id) ?? null,
            };
        }
        return c;
    });
}
