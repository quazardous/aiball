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
import { Router, type Request, type Response } from "express";
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
    addTicketTokenUsage,
    getTicketTokenUsage,
    isHuman,
    insertTypedRelation,
    listTypedRelationsForTicket,
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
import { computeTicketFlags, buildTicketFlagsContext } from "../db/ticket-flags.js";
import { listProjectSubscribers, listSubscriptions } from "../db/subscriptions.js";
import { isAssignmentLive, claimsToAutoRelease, pickFocusClaim } from "../db/assignment-gate.js";
import { compareWorkOrder, computeHotFocus, type WorkOrderCtx } from "../db/work-order.js";
import { globalConfigPath, assignWindowSec } from "../autopoll/config.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { RELATION_KINDS, isRelationKind, isLineageRelationKind, relationAxis, type RelationKind } from "../relations.js";
import { broadcast } from "../ws.js";
import { parseMeta } from "../questions.js";
import { getInboxAgg, emptyAgg } from "../db/inbox-agg.js";
import { badRequest, consumerOf, notFound, withTags, withTagsOne, withVotes } from "./_helpers.js";
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
export function ticketDecision(t: { meta?: string | null }, kind: string | null): boolean {
    if (!t.meta) return false;
    try {
        const d = (JSON.parse(t.meta) as { decision?: { kind?: string; status?: string } }).decision;
        if (!d || d.status !== "pending") return false;
        return kind === null ? true : d.kind === kind;
    } catch {
        // A malformed meta must never take a row down with it.
        return false;
    }
}

const DEFAULT_HOT_WINDOW_SEC = 1200;
function hotWindowSec(): number {
    try {
        const raw = parseYaml(readFileSync(globalConfigPath(), "utf8")) as { hot_window_sec?: unknown };
        const v = Number(raw?.hot_window_sec);
        return Number.isFinite(v) && v > 0 ? v : DEFAULT_HOT_WINDOW_SEC;
    } catch {
        return DEFAULT_HOT_WINDOW_SEC;
    }
}

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
    res.json({ ticket_id: id, by_agent });
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
    res.json({ ticket_id: id, released: true });
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
    res.json({ ticket_id: id, marker_id: markerId, ok: true });
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

    const tickets = listMessages({ kind: "ticket_created", project });
    // #1167 — the per-ticket aggregation (comment counts, lifecycle
    // replay, latest plan/resolution/escalation, lastSpeaker) is memoized
    // per project (write-invalidated + TTL ceiling) instead of replaying
    // the whole history on every hit. See db/inbox-agg.ts.
    const byTicket = getInboxAgg(project);
    const tagsMap = tagsForMessages(tickets.map((m) => m.id));
    const unreadMap = ticketUnreadFlags(consumerId, tickets.map((m) => m.id));
    // #427: per-ticket token-effort tally for the inbox row (one batched
    // query for the whole page). Absent for tickets with no captured usage
    // yet — the row renders the bolt chip only when estTokenCost > 0.
    const tokenUsageMap = getTicketTokenUsage(tickets.map((m) => m.id));
    // #405/#408/#532 (david `sfbsdy` + `neg428`) — VISIBILITY hot focus :
    // agrégé sur l'activité de TOUS les agents (#408 cross-agent restauré),
    // OR-é avec « ticket actuellement claimé par un agent » (david `neg428` :
    // « avec le claim ça devrait etre plus simple à flag »). Tous les viewers
    // (humans inclus) voient le même 🔥 → david peut spot « les tickets hot
    // de vos agents » sans imperonser. Pas de sort tiebreak dans /inbox donc
    // pas de selfHotFocus ici (utilisé dans /tickets pour le sort, là-bas
    // séparé pour préserver le ranking per-agent #532 `bmzpfr`).
    const crossAgentHotFocus = computeHotFocus(
        ticketAgentLastActivity(tickets.map((m) => m.id)),
        Date.now(),
        hotWindowSec() * 1000,
    );
    const nowStr = new Date().toISOString();
    let rows = tickets.map((t) => {
        const agg = byTicket.get(t.id) ?? emptyAgg();
        const postponedUntil = t.postponed_until ?? null;
        const postponed =
            !!postponedUntil && postponedUntil > nowStr;
        return {
            id: t.id,
            project: t.project,
            title: t.title,
            summary: t.summary ?? null,
            // #1161 S1 — list rows carry a SNIPPET, not the full body : bodies
            // were 75 % of the payload while the UI renders 140 chars max
            // (`snippetOf`). Full bodies stay on the per-ticket endpoints.
            snippet: (() => {
                const raw = (t.body ?? "").replace(/\s+/g, " ").trim();
                return raw.length > 140 ? raw.slice(0, 140) + "…" : raw || null;
            })(),
            by_agent: t.by_agent,
            created_at: t.created_at,
            status: t.status,
            intent: t.intent,
            priority: t.priority ?? "normal",
            closed: agg.closed || t.status === "rejected",
            // Same rationale as the /tickets/:id handler: resolved stays
            // true after close so the UI can distinguish "closed because
            // resolved" from "closed without explicit resolution".
            resolved: agg.resolved,
            // Agent-signalled "blocked, your call" (#B.119). Same rationale
            // as resolved: stays true after close so the UI can still show
            // *why* the ticket ended up closed.
            blocked: agg.blocked,
            // True iff there is a pending ticket_resolved on this ticket
            // that the reporter still has to accept-and-close or reject.
            // Stays false once the ticket is closed (the close auto-promotes
            // any dangling pending resolved, see submitMessage).
            pending_resolution: (agg.pendingResolution || ticketDecision(t, "resolution")) && !(agg.closed || t.status === "rejected"),
            /** #B.168 follow-up: latest resolution was rejected →
                flag for a `× rejected` badge on the inbox row. Same
                suppression as pending_resolution (cleared once
                ticket is closed/rejected). */
            latest_resolution_rejected: agg.latestResolutionRejected && !(agg.closed || t.status === "rejected"),
            /** #B.173: same flag for plan decisions. David: reject
                plan wasn't surfaced in the list view the way reject
                resolution is. Symmetric to latest_resolution_rejected
                — cleared once the ticket is closed/rejected so the
                badge represents "live unresolved rejection". */
            latest_plan_rejected: agg.latestPlanRejected && !(agg.closed || t.status === "rejected"),
            /** #656 david: pending PLAN flag. Symmetric to
                pending_resolution — surfaced so the inbox row can
                show "you have a plan to accept/reject" the same way
                it shows pending resolutions. Cleared once the ticket
                is closed/rejected. */
            pending_plan: (agg.pendingPlan || ticketDecision(t, "plan")) && !(agg.closed || t.status === "rejected"),
            /** #737 — pending ESCALATION flag. Symmetric to pending_plan.
                Drives the red ESCALATED badge on the inbox row. Cleared
                once the ticket is closed/rejected. */
            pending_escalation: (agg.pendingEscalation || ticketDecision(t, "escalation")) && !(agg.closed || t.status === "rejected"),
            /** #1835 — pending WONTFIX. The fourth decision kind, and the one
                nothing surfaced: it gates the ticket out of the agent's pool
                like a resolution does, so without this the row looked idle
                while it was in fact waiting on the reporter. */
            pending_wontfix: (agg.pendingWontfix || ticketDecision(t, "wontfix")) && !(agg.closed || t.status === "rejected"),
            /** #656 david `2c9qm4`: true iff a pending decision exists
                AND the decision-bearing comment IS the latest comment
                on the thread (no newer activity past the proposal).
                Drives the visual : fresh proposal = solid attention
                band, stale proposal (conversation continued past it)
                = dashed band. Null/false on rows with no pending
                decision. */
            pending_decision_is_latest: ((): boolean => {
                if (agg.closed || t.status === "rejected") return false;
                const pendingId = agg.pendingEscalation ? agg.latestEscalationId
                    : agg.pendingPlan ? agg.latestPlanId
                    : agg.pendingResolution ? agg.latestResolutionId
                    : agg.pendingWontfix ? agg.latestWontfixId
                    : 0;
                if (pendingId > 0) return pendingId === agg.lastSpeakerId;
                // #1835 — a decision filed WITH the ticket (`ticket_new({then})`)
                // has no comment to compare ids against. It is the freshest
                // signal exactly while nobody has spoken since.
                return ticketDecision(t, null) && agg.commentCount === 0;
            })(),
            scope: t.scope,
            // Per-consumer unread flag (≥1 unseen ping on the thread for
            // the caller, resolved from the X-Aiball-Consumer header).
            unread: unreadMap.get(t.id) ?? false,
            // #405/#532 (sfbsdy + s2sjxz) + #657 david — visibility cross-
            // agent : 🔥 s'allume sur activité récente (< hot_window_sec)
            // OR claim récent (claimed_at < hot_window_sec). Le claim
            // récent est un signal fort « un agent vient de prendre
            // ça » même avant qu il poste quoi que ce soit ; le filtre
            // sur hot_window_sec évite la régression #509 (s2sjxz —
            // claim 15h vieux marquant hot indéfiniment). Le bookmark-
            // fill chip distincte dans le meta slot reste pour exposer
            // QUI claim (info que `hot` seul perd).
            hot: crossAgentHotFocus.has(t.id)
                || (typeof t.claimed_at === "string"
                    && Date.now() - new Date(t.claimed_at).getTime() < hotWindowSec() * 1000),
            // Snooze (#B.329). `postponed=true` means the deadline hasn't
            // passed yet — UI hides the row from the open inbox the same
            // way `closed=true` does. `postponed_until` is the deadline
            // itself, surfaced as a chip on the row when relevant.
            postponed,
            postponed_until: postponedUntil,
            comment_count: agg.commentCount,
            pending_comment_count: agg.pendingCount,
            last_activity:
                agg.lastActivity && agg.lastActivity > t.created_at
                    ? agg.lastActivity
                    : t.created_at,
            // #B.132: who spoke last on this thread. Fallback to the
            // ticket creator when there are no comments yet — the
            // discrete "you spoke last" cue should still apply to
            // freshly created tickets the consumer just authored.
            last_speaker: agg.lastSpeaker ?? t.by_agent,
            tags: tagsMap.get(t.id) ?? [],
            // #427: accumulated token-effort tally (null until any usage is
            // captured) so the inbox row can surface the cost-equiv chip.
            token_usage: tokenUsageMap.get(t.id) ?? null,
            // #429: who currently holds this ticket, so the list can render a
            // compact claim/assign icon + tooltip naming the holder (parity
            // with the thread header). Two distinct holds (#436) — a row can
            // carry both: CLAIM (focus, agent self-declared) and ASSIGNMENT
            // (responsibility, a human push).
            claimant: t.claimant ?? null,
            claimed_at: t.claimed_at ?? null,
            assignee: t.assignee ?? null,
            assigned_at: t.assigned_at ?? null,
        };
    });

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

    rows.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

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
    const createdIds = created.map((m) => m.id);
    const crossAgentHotFocus = computeHotFocus(
        ticketAgentLastActivity(createdIds),
        Date.now(),
        hotWinMs,
    );
    const selfHotFocus = isHuman(consumerId)
        ? new Set<number>()
        : computeHotFocus(
            ticketSelfLastActivity(consumerId, createdIds),
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
        ticketIds: createdIds,
        nowMs: Date.now(),
        cooldownSec,
        closedSet,
        isClaimable,
        ownClaimIds,
        assignedToMeIds,
        claimedByOtherIds,
        crossAgentHot: crossAgentHotFocus,
        // #1573 — same effective value the claimable lens uses just above.
        canClaim: consumerCanClaim,
    });
    const tickets = created.map((m) => {
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
        const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
        // #402/#405/#532 : pour le sort tiebreak on prend SELF (per-agent), pas
        // cross-agent. Le ranking d'un agent suit son propre focus, pas celui
        // des autres (préserve la sémantique #532 `bmzpfr`). Le `hot` row flag
        // au-dessus utilise crossAgent pour la visibility (séparé exprès).
        const ctx: WorkOrderCtx = {
            tierOf: (id) =>
                // #461 — `assume_drained` flag skips the unread-tier check so
                // unread tickets fall into actionable-tier alongside the rest
                // and the head matches what `ticket_claim` returns AFTER the
                // agent drains its pings.
                (!assumeDrained && unreadMap.get(id)) ? 0 : actionableIds.has(id) ? 1 : openIds.has(id) ? 2 : 3,
            priorityWeight: (p) => PRIORITY_WEIGHT[p ?? "normal"] ?? 2,
            isHot: (id) => selfHotFocus.has(id),
            isOwnClaim: (id) => ownClaimIds.has(id), // #430: own live claim sorts above hot
            isAssignedToMe: (id) => assignedToMeIds.has(id), // #436(4): handed to me → below claim, above hot
        };
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
    res.json({ ticket_id: id, ...(opts ? { up_to_id: upToId } : {}), ...r });
});

ticketsRouter.post("/tickets/:id/mark-unread", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const r = markTicketUnseen(consumerOf(req), id);
    res.json({ ticket_id: id, ...r });
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
    res.json({ ticket_id: id, postponed_until: iso });
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
    res.json({ ticket_id: id, postponed_until: null });
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
    res.json(updated);
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
    res.json({ ticket_id: id, relations: listTypedRelationsForTicket(id) });
});

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
    if (
        !isHuman(caller) &&
        t.by_agent !== caller &&
        targetTicket.by_agent !== caller &&
        !callerIsProjectOwner
    ) {
        return res.status(403).json({
            error: `only a registered human moderator, the reporter of #${id} (${t.by_agent}) / #${target} (${targetTicket.by_agent}), or a project-owner of either project can relate them`,
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
    const all = listMessages({ project: t.project });
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
            if (d?.kind === "resolution" && d.status === "accepted") {
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
    const { actionableIds: hdrActionableIds } = computeActionableTicketIds(flagConsumer);
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
function enrichRelationStages<T extends { id: number; kind: string; source_ticket_id?: number | null }>(comments: T[]): (T & { source_ticket_stage?: string })[] {
    const sourceIds = new Set<number>();
    for (const c of comments) {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            sourceIds.add(c.source_ticket_id);
        }
    }
    if (sourceIds.size === 0) return comments;
    const stages = getTicketStages([...sourceIds]);
    return comments.map((c) => {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            return { ...c, source_ticket_stage: stages.get(c.source_ticket_id) ?? "open" };
        }
        return c;
    });
}
