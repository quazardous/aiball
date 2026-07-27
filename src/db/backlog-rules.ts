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
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { mentions } from "../mentions.js";
import { getDb, nowIso } from "./connection.js";
import { getConsumer } from "./consumers.js";

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
    /** #1573 — false = "specialist" consumer (`can_claim=false`): the
     *  `--role crew` worker or a project declaring `no_claim: true`. Such a
     *  consumer consumes ONLY what is pushed to it. */
    canClaim: boolean;
    /** #1573 — tickets whose body, or any comment in the thread, addresses
     *  this consumer by `@name`. Populated ONLY when `canClaim === false`
     *  (the rule that reads it is inert otherwise), so a normal consumer
     *  pays nothing for it. */
    mentionsMeIds: Set<number>;
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
        // #918 david `eyqk9x` : scoper la rule aux ticket-events
        // (ticket_created via ticketRowToRuleItem, `commentByAgent`
        // undefined). Sans ce scope la rule mismatch sur les
        // comment_added : `messageRowToRuleItem` met
        // ticketByAgent = parent.byAgent (= auteur du ticket parent),
        // donc un autre agent qui commente sur MON ticket avait
        // ticketByAgent === me → exclu de fifo-wake (= wake CTA rendait
        // backlog template au lieu de comment template). Conséquence
        // observable depuis e8059c4 : tous les comments d'autres sur
        // mes tickets silencés du wake CTA (= bug #908/#918). Les
        // self-comments restent couverts par `self-authored-comment`
        // juste en-dessous.
        name: "self-authored-ticket",
        when: (ctx, item) =>
            item.ticketByAgent != null && item.ticketByAgent === ctx.consumerId
            && item.commentByAgent == null,
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
    {
        // #1573 — le PENDANT de `assigned-to-other`, pour un consumer
        // spécialiste (`can_claim=false`). Cette règle-là couvre « assigné à
        // quelqu'un d'autre » ; il manquait « assigné à personne ». Pour un
        // consumer normal, le non-assigné EST le pool claimable partagé, donc
        // c'est son travail. Pour un spécialiste c'est exactement ce qu'il n'a
        // pas le droit de prendre — d'où deux chemins qui divergeaient (le set
        // claimable appliquait le contrat #508, le backlog l'ignorait).
        //
        // Exemption tranchée par david : une mention `@moi` explicite réveille
        // quand même. S'adresser nommément à un agent doit porter, sinon un
        // spécialiste devient injoignable hors assignment.
        //
        // Pas dans `unread-list`/`unread-count` — même convention que
        // `assigned-to-other` : le thread reste visible, il ne peuple ni le
        // work-order ni la FIFO.
        name: "unassigned-for-no-claim",
        when: (ctx, item) =>
            ctx.canClaim === false
            && item.assignee !== ctx.consumerId
            // Defensive, comme claimed-by-other : un caller legacy peut passer
            // un ctx construit avant #1573.
            && !(ctx.mentionsMeIds?.has(item.ticketId) ?? false),
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
        /**
         * #1573 — the EFFECTIVE claim capability. Callers holding a request
         * must pass it, because the effective value is `DB flag AND NOT the
         * `x-aiball-no-claim` header hint` — and the claimable lens already
         * resolves it that way. Passing it is what keeps backlog and claimable
         * from diverging again, which is the whole bug. Omitted → read the DB
         * flag (the case for callers with no request in hand).
         */
        canClaim?: boolean;
    } = {},
): BacklogRulesCtx {
    const nowMs = opts.nowMs ?? Date.now();
    const claimedByOtherIds = opts.claimedByOtherIds ?? new Set<number>();
    const canClaim = opts.canClaim ?? (getConsumer(consumerId)?.can_claim !== false);
    // Only a specialist reads this set, so only a specialist pays for it.
    const mentionsMeIds = canClaim ? new Set<number>() : ticketsMentioning(consumerId);
    if (opts.closedIds && opts.snoozedIds) {
        return {
            consumerId, nowMs, closedIds: opts.closedIds, snoozedIds: opts.snoozedIds,
            claimedByOtherIds, canClaim, mentionsMeIds,
        };
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
    return { consumerId, nowMs, closedIds, snoozedIds, claimedByOtherIds, canClaim, mentionsMeIds };
}

/**
 * #1573 — tickets that address `agent` by `@name`, in their own body or in any
 * comment of the thread.
 *
 * Two steps on purpose. The SQL `LIKE` is a cheap superset filter — it also
 * catches `@agentX`, and mentions buried in code fences — and it is the only
 * part whose cost scales with the table. The exact `extractMentions` (the same
 * one the ping fan-out runs, so a mention means one thing everywhere) then runs
 * on the handful of rows that matched, not on the backlog. Measured on the live
 * DB: ~15 ms for 13k messages, and only for a specialist consumer.
 *
 * No migration: persisting a "why" on the ping row was the alternative, and it
 * would have bought the same answer at the price of a schema change.
 */
function ticketsMentioning(agent: string): Set<number> {
    const db = getDb();
    const like = `%@${agent}%`;
    const rows = db.all<{ ticket_id: number; body: string | null }>(sql`
        SELECT ${schema.tickets.id} AS ticket_id, ${schema.tickets.body} AS body
          FROM ${schema.tickets}
         WHERE ${schema.tickets.body} LIKE ${like}
        UNION ALL
        SELECT ${schema.messages.ticketId} AS ticket_id, ${schema.messages.body} AS body
          FROM ${schema.messages}
         WHERE ${schema.messages.body} LIKE ${like}
           AND ${schema.messages.status} = 'approved'
    `);
    const out = new Set<number>();
    for (const r of rows) {
        if (r.ticket_id == null) continue;
        if (out.has(r.ticket_id)) continue;
        if (mentions(r.body, agent)) out.add(r.ticket_id);
    }
    return out;
}

/** Singleton with the default rule set. */
export const defaultBacklogRules = new BacklogRules();
