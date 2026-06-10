/**
 * BacklogRules — first-class rules engine that pilots ALL the "is this
 * item in my queue / count / backlog" predicates from a single place.
 *
 * Why : pre-refactor, the same conditions (closed, snoozed, self-authored,
 * assigned-to-other) were duplicated across `actionableTicketGate`
 * (pings.ts), `computeTicketFlags` (ticket-flags.ts), and the 4 read
 * helpers in pings.ts. Changing "does closed exclude X target ?" required
 * touching N files in sync — observed live as the #805 desync between
 * `e:` bar counter and `claude-loop backlog` CLI.
 *
 * Model :
 *   - **Rule** = a first-class predicate (`closed`, `snoozed`,
 *     `self-authored-ticket`, `self-authored-comment`, `assigned-to-other`).
 *   - **Target** = a logical surface that consumes rules
 *     (`unread-list`, `unread-count`, `fifo-wake`, `backlog-tier`,
 *     `actionable-pool`, `hot-tier`).
 *   - Each rule declares the targets it EXCLUDES from. The engine
 *     dispatches a `filter(items, target)` over the active rules.
 *
 * To add a rule : append to `DEFAULT_RULES` with its `excludesFrom` set.
 * To retarget an existing rule : edit one `excludesFrom`.
 * To audit : `rules.rulesFor(target)` lists every rule that affects it.
 */
import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export type Target =
    | "unread-list"
    | "unread-count"
    | "fifo-wake"
    | "backlog-tier"
    | "actionable-pool"
    | "hot-tier";

export interface BacklogRulesCtx {
    consumerId: string;
    nowMs: number;
    /** Tickets whose last lifecycle event is `ticket_closed`. */
    closedIds: Set<number>;
    /** Tickets with `postponed_until > now`. */
    snoozedIds: Set<number>;
    /** #900 — Tickets with a live claim by another agent (claimant !=
     *  consumerId, within the claim window). Used by the rule
     *  `claimed-by-other` to keep these out of MY backlog + wake (= they
     *  belong to the claimant's work-order until they release). */
    claimedByOtherIds: Set<number>;
}

/**
 * Shape an item provides to the rules. Consumers convert their row.
 * Fields are optional so a rule that doesn't need a field can stay
 * silent — e.g. `closed` only reads `ticketId`.
 */
export interface RuleItem {
    /** Parent ticket id. Always set. */
    ticketId: number;
    /** Ticket author. Null when only the comment side is known. */
    ticketByAgent?: string | null;
    /** Comment author. Null when item is the ticket itself. */
    commentByAgent?: string | null;
    /** Comment message kind. Null when item is the ticket itself. */
    commentKind?: string | null;
    /** Ticket assignee. */
    assignee?: string | null;
}

export interface BacklogRule {
    name: string;
    when: (ctx: BacklogRulesCtx, item: RuleItem) => boolean;
    excludesFrom: ReadonlySet<Target>;
}

/**
 * Shipped rules — the single source of truth for queue/count/backlog
 * gating. Editing an `excludesFrom` set propagates to every consumer
 * that consumes the matching target.
 */
export const DEFAULT_RULES: readonly BacklogRule[] = Object.freeze([
    {
        name: "closed",
        when: (ctx, item) => ctx.closedIds.has(item.ticketId),
        // #805 : closed reste visible dans unread-list/unread-count
        // jusqu'au prune-on-MCP-consult. Le gate ne shadow-filtre PAS
        // les events qui annoncent la fermeture (resolution_accepted,
        // ticket_closed, etc.) — david doit voir ses propres decisions.
        excludesFrom: new Set<Target>(["backlog-tier", "actionable-pool", "hot-tier"]),
    },
    {
        name: "snoozed",
        when: (ctx, item) => ctx.snoozedIds.has(item.ticketId),
        excludesFrom: new Set<Target>([
            "unread-list",
            "unread-count",
            "fifo-wake",
            "backlog-tier",
            "actionable-pool",
            "hot-tier",
        ]),
    },
    {
        name: "self-authored-ticket",
        when: (ctx, item) =>
            item.ticketByAgent != null && item.ticketByAgent === ctx.consumerId,
        excludesFrom: new Set<Target>(["unread-list", "unread-count", "fifo-wake"]),
    },
    {
        name: "self-authored-comment",
        when: (ctx, item) =>
            item.commentByAgent != null && item.commentByAgent === ctx.consumerId,
        excludesFrom: new Set<Target>(["unread-list", "unread-count", "fifo-wake"]),
    },
    {
        // #900/#904 david : un ticket assigné à un autre agent ne doit pas
        // déclencher de wake CTA sur moi (= symétrique à claimed-by-other).
        // Le ticket reste visible (unread-list/count restent NON-filtrés)
        // mais ne peuple pas mon work-order ni ma FIFO.
        name: "assigned-to-other",
        when: (ctx, item) =>
            item.assignee != null && item.assignee !== ctx.consumerId,
        excludesFrom: new Set<Target>(["backlog-tier", "fifo-wake"]),
    },
    {
        // #900 david : "ouvre un ticket sur ça ça devrait pas te fire".
        // Si un autre agent détient un claim vivant sur le ticket, il
        // appartient à SON work-order — pas dans mon backlog ni fifo-wake.
        // Exclut symétriquement à assigned-to-other mais sur la base du
        // claim (temporaire) au lieu de l'assignment (persistant).
        name: "claimed-by-other",
        // Defensive : ctx.claimedByOtherIds peut être undefined si un caller
        // legacy passe un BacklogRulesCtx avant la migration #900 (CLI cache).
        when: (ctx, item) => ctx.claimedByOtherIds?.has(item.ticketId) ?? false,
        excludesFrom: new Set<Target>(["backlog-tier", "fifo-wake"]),
    },
]);

export class BacklogRules {
    constructor(readonly rules: readonly BacklogRule[] = DEFAULT_RULES) {}

    /** True iff at least one rule active on `target` matches `item`. */
    excludes(ctx: BacklogRulesCtx, item: RuleItem, target: Target): boolean {
        for (const r of this.rules) {
            if (!r.excludesFrom.has(target)) continue;
            if (r.when(ctx, item)) return true;
        }
        return false;
    }

    /** Drop items that any rule on `target` excludes. */
    filter<I>(items: I[], toItem: (i: I) => RuleItem, ctx: BacklogRulesCtx, target: Target): I[] {
        return items.filter((i) => !this.excludes(ctx, toItem(i), target));
    }

    /** Audit : list every rule that affects `target`. */
    rulesFor(target: Target): BacklogRule[] {
        return this.rules.filter((r) => r.excludesFrom.has(target));
    }
}

/**
 * Build the precomputed context. One DB pass for closed + snoozed.
 * Callers that already have these sets (e.g. an API route that
 * project-scopes them) can pass overrides.
 */
export function buildBacklogRulesCtx(
    consumerId: string,
    opts: {
        nowMs?: number;
        closedIds?: Set<number>;
        snoozedIds?: Set<number>;
        claimedByOtherIds?: Set<number>;
    } = {},
): BacklogRulesCtx {
    const nowMs = opts.nowMs ?? Date.now();
    const claimedByOtherIds = opts.claimedByOtherIds ?? new Set<number>();
    if (opts.closedIds && opts.snoozedIds) {
        return { consumerId, nowMs, closedIds: opts.closedIds, snoozedIds: opts.snoozedIds, claimedByOtherIds };
    }
    const db = getDb();
    let closedIds = opts.closedIds;
    if (!closedIds) {
        // Net-closed = last lifecycle event approved per ticket = ticket_closed.
        // Replay in id order ; reopen drops the id from the set.
        const events = db.select({
            ticket_id: schema.messages.ticketId,
            kind: schema.messages.kind,
        })
            .from(schema.messages)
            .where(and(
                inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
                eq(schema.messages.status, "approved"),
            ))
            .orderBy(asc(schema.messages.id))
            .all();
        closedIds = new Set<number>();
        for (const ev of events) {
            if (ev.ticket_id == null) continue;
            if (ev.kind === "ticket_closed") closedIds.add(ev.ticket_id);
            else closedIds.delete(ev.ticket_id);
        }
    }
    let snoozedIds = opts.snoozedIds;
    if (!snoozedIds) {
        const now = nowIso();
        const rows = db.select({ id: schema.tickets.id })
            .from(schema.tickets)
            .where(and(
                isNotNull(schema.tickets.postponedUntil),
                gt(schema.tickets.postponedUntil, now),
            ))
            .all();
        snoozedIds = new Set(rows.map((r) => r.id));
    }
    return { consumerId, nowMs, closedIds, snoozedIds, claimedByOtherIds };
}

/** Singleton with the default rule set. */
export const defaultBacklogRules = new BacklogRules();
