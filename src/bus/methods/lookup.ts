/**
 * #3067 — finding tickets and following them, on the bus: the ticket list an
 * agent works from, search, the reference graph, the decisions waiting on the
 * caller, and project and ticket subscriptions. Subscriptions take
 * `consumer_id` as the routes did, and default it to the caller.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { flag } from "../params.js";
import {
    deleteSubscription,
    deleteTicketSubscription,
    getMessage,
    getTicketSubscriptionState,
    listPendingDecisionsForReporter,
    listPlansToExecute,
    listSubscriptions,
    listTicketSubscriptions,
    upsertSubscription,
    upsertTicketSubscription,
} from "../../db.js";
import { listTicketsFor } from "../../api/tickets.js";
import { searchMessages } from "../../search.js";
import { graphAudit, ticketNeighbors } from "../../db/graph-query.js";
import { ERROR_CODES, INTENTS, type Intent } from "../../domain.js";

function whose(caller: Caller, named: string | undefined): string {
    return named || consumerIdOf(caller);
}

/** A number from a query string, or its absence: what `Number(x) || undefined` did. */
const loose = z.preprocess((v) => (v === undefined || v === "" ? undefined : Number(v) || undefined), z.number().optional());

/**
 * The ticket list an agent works from (`ticket_list`): its filters are the
 * query the route took (`project`, `open`, `actionable`, `claimable`, `tag`,
 * `since`…), each a string or a yes/no.
 */
defineMethod({
    name: "ticket.list",
    who: ["human", "agent"],
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    run: (caller, p) => {
        // The list reads its filters as the query strings HTTP gives: a yes is "1".
        const query: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(p)) {
            query[k] = typeof v === "boolean" ? (v ? "1" : "0") : Array.isArray(v) ? v : String(v);
        }
        return listTicketsFor(consumerIdOf(caller), query, { noClaimHint: caller.no_claim_hint === true });
    },
});

/**
 * Full-text search over titles, bodies and comments; hits on a snoozed
 * ticket are left out unless `include_postponed`.
 */
defineMethod({
    name: "message.search",
    who: ["human", "agent"],
    params: z.object({
        q: z.string().optional(),
        project: z.string().optional(),
        open: flag,
        include_postponed: flag,
        intent: z.string().optional(),
        limit: loose,
        since: z.string().optional(),
    }),
    run: (_caller, p) => {
        const q = p.q ?? "";
        if (!q.trim()) return [];
        const intent = p.intent && INTENTS.includes(p.intent as Intent) ? (p.intent as Intent) : undefined;
        const hits = searchMessages(q, { project: p.project, open: p.open === true, intent, limit: p.limit, since: p.since });
        if (p.include_postponed === true) return hits;
        // Leave out hits whose ticket is snoozed now.
        const now = new Date().toISOString();
        const snoozed = new Set<number>();
        for (const h of hits) {
            const t = getMessage(h.ticket_id);
            if (t?.kind === "ticket_created" && t.postponed_until && t.postponed_until > now) snoozed.add(h.ticket_id);
        }
        return hits.filter((h) => !snoozed.has(h.ticket_id));
    },
});

/**
 * #1992 — a ticket's neighbours in the reference graph, as the caller may see
 * them: its own projects in full, elsewhere only that a link crosses.
 */
defineMethod({
    name: "graph.neighbors",
    who: ["human", "agent"],
    params: z.object({ ticket_id: z.coerce.number(), min_weight: loose, limit: loose }),
    run: (caller, p) => {
        if (!Number.isSafeInteger(p.ticket_id) || p.ticket_id <= 0) throw new Refusal(400, "ticket_id required");
        return ticketNeighbors(p.ticket_id, { minWeight: p.min_weight, limit: p.limit, consumerId: consumerIdOf(caller) });
    },
});

/** #1992 — the graph's audit: dangling and suspicious references, as the caller may see them. */
defineMethod({
    name: "graph.audit",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional(), limit: loose }),
    run: (caller, p) => graphAudit({ project: p.project, limit: p.limit, consumerId: consumerIdOf(caller) }),
});

/** #697 — pending plans and resolutions on open tickets the caller reports: its arbitrage queue. */
defineMethod({
    name: "decision.mine",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => ({ decisions: listPendingDecisionsForReporter(consumerIdOf(caller)) }),
});

/** #1164 — the caller's plans that were accepted and not acted on since. */
defineMethod({
    name: "decision.plans_to_execute",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => ({ plans: listPlansToExecute(consumerIdOf(caller)) }),
});

/** Subscribe a consumer to a project, as `owner` or `follower`. */
defineMethod({
    name: "project.subscribe",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), project: z.string().min(1), role: z.enum(["owner", "follower"]).nullish() }),
    run: (caller, p) => upsertSubscription(whose(caller, p.consumer_id), p.project, p.role ?? undefined),
});

/** Project subscriptions: one consumer's, or everyone's when `consumer_id` is left out. */
defineMethod({
    name: "project.subscriptions",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional() }),
    run: (_caller, p) => listSubscriptions(p.consumer_id),
});

/** Remove a consumer's subscription to a project. */
defineMethod({
    name: "project.unsubscribe",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), project: z.string().min(1) }),
    run: (caller, p) => {
        deleteSubscription(whose(caller, p.consumer_id), p.project);
        return null;
    },
});

/** The tickets a consumer follows or muted, beyond its projects' roles. */
defineMethod({
    name: "ticket.subscriptions",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        return { consumer_id, subscriptions: listTicketSubscriptions(consumer_id) };
    },
});

/** #352 — follow a ticket, or mute it (`muted`: no pings, even by role). */
defineMethod({
    name: "ticket.subscribe",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), ticket_id: z.number().int(), muted: z.boolean().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const t = getMessage(p.ticket_id);
        if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
        const muted = p.muted === true;
        upsertTicketSubscription(consumer_id, p.ticket_id, muted);
        return { consumer_id, ticket_id: p.ticket_id, muted };
    },
});

/** #352 — a consumer's relation to one ticket: "followed", "muted", or null (its role decides). */
defineMethod({
    name: "ticket.subscription",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), ticket_id: z.coerce.number().int() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        return { consumer_id, ticket_id: p.ticket_id, state: getTicketSubscriptionState(consumer_id, p.ticket_id) };
    },
});

/** Stop following (or unmute) a ticket: back to what the consumer's role says. */
defineMethod({
    name: "ticket.unsubscribe",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), ticket_id: z.coerce.number().int() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        deleteTicketSubscription(consumer_id, p.ticket_id);
        return { consumer_id, ticket_id: p.ticket_id, removed: true };
    },
});
