/**
 * #791 — centralised per-ticket flag computation.
 *
 * Why this file exists
 * --------------------
 * The /api/tickets route handler used to build 5-6 independent Sets
 * (actionableIds, lastByMe, decisionGated, cooled, claimable, …) and
 * combine them inline with ad-hoc AND/OR clauses. Every new nuance was
 * a new Set + a new clause, and the assembly logic lived in the route.
 * Result: #790 (tier-2 missed the decision gate), #788 (tier-2 missed
 * the cooldown side-effects), #786 (the cooldown plumbing duplicated
 * the existing exclusion pattern).
 *
 * Now the route delegates to a single PURE function `computeTicketFlags`
 * that takes one ticket row plus a precomputed context and returns a
 * flag bag the row carries on the wire. Filters become row-level boolean
 * checks. Adding a new condition means editing ONE function; all callers
 * (UI, MCP, claude-loop) benefit automatically.
 *
 * Purity contract
 * ---------------
 * `computeTicketFlags(ticket, ctx)` does NO I/O, NO DB access, NO
 * `Date.now()` — the wall-clock arrives via `ctx.nowMs`. Output is a
 * deterministic function of (ticket, ctx). Trivially unit-testable
 * without mocks. The impure factory `buildTicketFlagsContext` is the
 * single place where DB reads happen.
 */
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import {
    computeActionableTicketIds,
    lastActorExclusions,
    decisionGateByTicket,
    backlogCooldownExclusions,
    type ActionableTicketSet,
} from "./projects.js";
import { assignWindowSec } from "../autopoll/config.js";
import { ticketUnreadFlags } from "./pings.js";
import {
    buildBacklogRulesCtx,
    defaultBacklogRules,
    type BacklogRulesCtx,
} from "./backlog-rules.js";

/**
 * Per-row flag bag exposed on `/api/tickets` responses. The boolean
 * fields drive every filter; the string fields are surfaced for the UI
 * and for agent introspection.
 *
 * `backlog_tier` is the headline:
 *   - 0 → HOT focus.
 *   - 1 → actionable, ball in MY court (formal).
 *   - 2 → follow-up (#885): last_actor ≠ me, decision pending. They
 *     spoke but my pending plan/resolution gates `actionable`. Soft
 *     surface — without it the thread disparait du backlog.
 *   - 3 → waiting on them. I was the last actor, no decision pending.
 *   - null → not in this consumer's backlog.
 *
 * `backlog_cooled_until` is set ONLY when a recent backlog wake on this
 * ticket would still be in its cooldown window. Lets the UI show
 * "re-surface in N min". The row stays in `backlog_tier` 1 or 2 — the
 * cooldown is an orthogonal suppression, not a tier flip.
 */
export interface TicketFlags {
    unread: boolean;
    actionable: boolean;
    claimable: boolean;
    is_claim: boolean;
    hot: boolean;
    /** #791 wahxsj — tier in the backlog, lower number = higher focus:
     *   - 0 = HOT focus (overrides everything; cross-agent activity within
     *         the hot window)
     *   - 1 = actionable (ball in my court; same set the wake-CTA points
     *         at by default)
     *   - 2 = waiting on them (I was the last actor, no decision pending)
     *   - null = not in this consumer's backlog
     * Sorts naturally with numeric asc (hot → actionable → follow-up →
     * waiting); the route filter `?backlog=1` keeps every row whose
     * `backlog_tier !== null`. */
    backlog_tier: 0 | 1 | 2 | 3 | null;
    backlog_cooled_until: string | null;
    gated_by_decision: boolean;
    last_actor: string | null;
    last_actor_at: string | null;
}

/**
 * The precomputed sets/maps a single API request needs. One context per
 * request, shared across every row in that request. All fields are
 * cheap to look up by id; no field requires DB access at row time.
 */
export interface TicketFlagsContext {
    consumerId: string;
    unreadIds: Set<number>;
    actionableIds: Set<number>;
    openIds: Set<number>;
    /** Tickets where I'm the last actor AND a counterpart exists. Drives
     *  tier 2 of the backlog wake. Same set the legacy
     *  `lastActorExclusions` returned. */
    lastActorMeIds: Set<number>;
    /** Per-ticket pending-decision gate. true → a then:plan or
     *  then:resolved is sitting unresolved on the thread; the ticket is
     *  in awaiting-validation state and should NOT appear in the wake. */
    decisionGated: Map<number, boolean>;
    /** Per-ticket wake_at ISO from the backlog wake log. Empty when no
     *  recent wake fired. The flag function turns wake_at + cooldown_sec
     *  into `backlog_cooled_until` (only when still in the future). */
    cooledWakeAt: Map<number, string>;
    /** Live claims held by this consumer (claimant=me, within window). */
    ownClaimIds: Set<number>;
    /** Tickets explicitly assigned to me (a human handed them over). */
    assignedToMeIds: Set<number>;
    /** Visibility flag: tickets currently in the agent-hot zone
     *  (cross-agent view — same flag is shown to every requester). */
    crossAgentHot: Set<number>;
    /** Per-ticket `(last_actor, last_actor_at)` denorm from the tickets
     *  table. Surfaced on the row for UI/agent introspection. */
    lastActorByTicket: Map<number, { actor: string | null; at: string | null }>;
    /** Lifecycle-replay net-closed set. Open if not in this set. Kept
     *  for the route handler's per-row `closed` boolean — the gating
     *  pour `backlog_tier` lui passe désormais via `rulesCtx`. */
    closedSet: Set<number>;
    /** #886 — BacklogRules ctx (closed + snoozed sets) injecté ici pour
     *  que `computeTicketFlags` consomme le moteur de règles unique. */
    rulesCtx: BacklogRulesCtx;
    /** Per-row claimability — respects no-claim (assignment-only) and
     *  the consumer's owned-project set. The route handler builds this
     *  closure; we just call it. */
    isClaimable: (id: number, project: string, assignee: string | null) => boolean;
    /** Wall-clock for the request — purity hook for `computeTicketFlags`. */
    nowMs: number;
    /** When > 0, `cooledWakeAt[id] + cooldownSec > nowMs` populates
     *  `backlog_cooled_until` on the row. 0 disables the surface. */
    cooldownSec: number;
}

/** Shape of the ticket row this fn consumes (subset of `schema.Ticket`). */
export interface TicketFlagsRow {
    id: number;
    project: string;
    byAgent?: string | null;
    assignee?: string | null;
    postponed_until?: string | null;
}

/**
 * Pure: given one ticket row + the precomputed context, return its
 * flag bag. No I/O, no Date.now, no module-level state.
 */
export function computeTicketFlags(t: TicketFlagsRow, ctx: TicketFlagsContext): TicketFlags {
    const unread = ctx.unreadIds.has(t.id);
    const actionable = ctx.actionableIds.has(t.id);
    const claimable = ctx.isClaimable(t.id, t.project, t.assignee ?? null);
    const is_claim = ctx.ownClaimIds.has(t.id);
    const hot = ctx.crossAgentHot.has(t.id);
    const gated_by_decision = ctx.decisionGated.get(t.id) === true;
    const lastActorRow = ctx.lastActorByTicket.get(t.id);
    const last_actor = lastActorRow?.actor ?? null;
    const last_actor_at = lastActorRow?.at ?? null;

    // #886 — toute condition d'exclusion (closed, snoozed,
    // assigned-to-other) vit dans `backlog-rules.ts`. Une seule
    // checkbox ici : "does any active rule exclude this row from the
    // backlog-tier target ?".
    const ruleItem = {
        ticketId: t.id,
        ticketByAgent: t.byAgent ?? null,
        assignee: t.assignee ?? null,
    };
    const excludedFromBacklog = defaultBacklogRules.excludes(ctx.rulesCtx, ruleItem, "backlog-tier");
    let backlog_tier: 0 | 1 | 2 | 3 | null = null;
    if (!excludedFromBacklog) {
        // #885 david : ajouter un tier "follow-up" pour les threads où
        // l'autre a répondu en dernier mais une décision pending gate
        // l'actionable. Sans ça, ces tickets disparaissent du backlog.
        const lastActorOther = last_actor != null && last_actor !== ctx.consumerId;
        const followUp = lastActorOther && gated_by_decision;
        const lastActorMe = ctx.lastActorMeIds.has(t.id);
        const waiting = lastActorMe && !gated_by_decision;
        const inPool = actionable || followUp || waiting;
        if (hot && inPool) {
            backlog_tier = 0;
        } else if (actionable) {
            // Tier 1 — ball in my court (formal).
            backlog_tier = 1;
        } else if (followUp) {
            // Tier 2 — they spoke but my decision pending gates
            // actionable. Soft surface (#885).
            backlog_tier = 2;
        } else if (waiting) {
            // Tier 3 — I was last actor, no decision pending: the
            // reporter is sitting on it. Soft reminder.
            backlog_tier = 3;
        }
    }

    let backlog_cooled_until: string | null = null;
    if (backlog_tier !== null && ctx.cooldownSec > 0) {
        const wakeAt = ctx.cooledWakeAt.get(t.id);
        if (wakeAt) {
            const wakeAtMs = Date.parse(wakeAt);
            if (Number.isFinite(wakeAtMs)) {
                const untilMs = wakeAtMs + ctx.cooldownSec * 1000;
                if (untilMs > ctx.nowMs) {
                    backlog_cooled_until = new Date(untilMs).toISOString();
                }
            }
        }
    }

    return {
        unread,
        actionable,
        claimable,
        is_claim,
        hot,
        backlog_tier,
        backlog_cooled_until,
        gated_by_decision,
        last_actor,
        last_actor_at,
    };
}

/**
 * Impure factory: query every helper once and pack the result for
 * `computeTicketFlags`. One call per /api/tickets request. The route
 * handler hands over the ticket-id universe (the set of created ids
 * already on hand) so the underlying queries can scope where they
 * need to.
 */
export function buildTicketFlagsContext(args: {
    consumerId: string;
    ticketIds: number[];
    nowMs: number;
    cooldownSec: number;
    /** Lifecycle-replay net-closed set, computed by the route handler
     *  from the same listMessages it already iterates for display. */
    closedSet: Set<number>;
    /** Same closure shape the legacy code built — keeps the no-claim
     *  + owned-project + assignee logic in one spot. */
    isClaimable: (id: number, project: string, assignee: string | null) => boolean;
    /** Ids the consumer holds a live claim on (computed by the caller
     *  from the same `created` rows we iterate). */
    ownClaimIds: Set<number>;
    /** Ids the consumer is the explicit assignee of (same source). */
    assignedToMeIds: Set<number>;
    /** #900 — Ids where another agent holds a live claim. Drives the
     *  BacklogRules `claimed-by-other` exclusion (backlog + wake). */
    claimedByOtherIds: Set<number>;
    /** Cross-agent hot focus set (visible flag, computed by the caller
     *  via `computeHotFocus(ticketAgentLastActivity(ids), …)`. */
    crossAgentHot: Set<number>;
}): TicketFlagsContext {
    const db = getDb();
    const { consumerId, ticketIds, nowMs, cooldownSec, closedSet,
        isClaimable, ownClaimIds, assignedToMeIds, claimedByOtherIds, crossAgentHot } = args;

    const unreadMap = ticketUnreadFlags(consumerId, ticketIds);
    const unreadIds = new Set<number>();
    for (const id of ticketIds) {
        if (unreadMap.get(id)) unreadIds.add(id);
    }
    const { openIds, actionableIds } = computeActionableTicketIds(consumerId);
    const lastActorMeIds = lastActorExclusions(consumerId);
    const decisionGated = decisionGateByTicket();
    const cooledIds = cooldownSec > 0
        ? backlogCooldownExclusions(consumerId, cooldownSec)
        : new Set<number>();
    // `backlogCooldownExclusions` already cross-checks against
    // `last_actor_at`; we just need the underlying wake_at to derive
    // the "until" timestamp for the row. Read the log once.
    const cooledWakeAt = new Map<number, string>();
    if (cooledIds.size > 0) {
        const rows = db.select({
            ticketId: schema.backlogWakeLog.ticketId,
            wakeAt: schema.backlogWakeLog.wakeAt,
        }).from(schema.backlogWakeLog)
            .all();
        for (const r of rows) {
            if (cooledIds.has(r.ticketId)) cooledWakeAt.set(r.ticketId, r.wakeAt);
        }
    }
    // Per-ticket (last_actor, last_actor_at) for UI/agent introspection.
    // Read once; the table is denorm so this is a cheap scan even on
    // large boards.
    const lastActorRows = db.select({
        id: schema.tickets.id,
        actor: schema.tickets.lastActor,
        at: schema.tickets.lastActorAt,
    }).from(schema.tickets).all();
    const lastActorByTicket = new Map<number, { actor: string | null; at: string | null }>();
    for (const r of lastActorRows) {
        lastActorByTicket.set(r.id, { actor: r.actor ?? null, at: r.at ?? null });
    }

    // #886 — moteur de règles : injecte le closedSet déjà calculé par
    // le route handler (project-scoped) plutôt que de redoubler la pass.
    const rulesCtx = buildBacklogRulesCtx(consumerId, {
        nowMs,
        closedIds: closedSet,
        claimedByOtherIds,
    });
    return {
        consumerId,
        unreadIds,
        actionableIds,
        openIds,
        lastActorMeIds,
        decisionGated,
        cooledWakeAt,
        ownClaimIds,
        assignedToMeIds,
        crossAgentHot,
        lastActorByTicket,
        closedSet,
        rulesCtx,
        isClaimable,
        nowMs,
        cooldownSec,
    };
}

/**
 * #791 helper — recompute the assignWindow constant in one place. The
 * route handler keeps its own `claimNowMs` to avoid threading it through
 * every closure; this fn just exposes the same window seconds the
 * `isClaimable` closure already uses internally.
 */
export function liveAssignWindowMs(): number {
    return assignWindowSec() * 1000;
}

// Re-export the `ActionableTicketSet` shape so callers don't have to
// reach into `projects.ts` themselves.
export type { ActionableTicketSet };
