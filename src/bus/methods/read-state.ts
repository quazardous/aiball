/**
 * #3067 — a consumer's read state on the bus: its unread FIFO and counters, its
 * pings, marking them read, and the backlog wakes the loop records. Each takes
 * `consumer_id` as the routes did, and defaults it to the caller.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { flag } from "../params.js";
import {
    isHuman,
    listPings,
    listUnread,
    markAllSeenForProject,
    markMessageSeen,
    markPingsRead,
    markSeenUpToForProject,
    pendingTicketsByAuthor,
    prunePings,
    recordBacklogWake,
    unreadCount,
    unreadPingCount,
} from "../../db.js";
import { ticketsAwaitingModeration } from "../../db/tickets.js";
import { withTags } from "../../queries/decorate.js";
import { ERROR_CODES } from "../../domain.js";

/** The consumer a call is about: the one named, else the caller. */
function whose(caller: Caller, named: string | undefined): string {
    return named || consumerIdOf(caller);
}

const project = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

/**
 * The consumer's unread events, oldest first (#800: across projects when
 * `project` is left out), each stamped with whether a human wrote it (#2042)
 * and whether its ticket still awaits moderation (#2759).
 */
defineMethod({
    name: "unread.list",
    who: ["human", "agent"],
    params: z.object({
        consumer_id: z.string().optional(),
        project,
        limit: z.coerce.number().int().optional(),
        since: z.string().optional(),
    }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const proj = p.project ?? null;
        const messages = listUnread(consumer_id, proj, p.limit ?? 100, p.since);
        // Cached per author: one FIFO page repeats a handful.
        const humanBy = new Map<string, boolean>();
        const awaiting = ticketsAwaitingModeration(messages.map((m) => m.ticket_id ?? m.id));
        const stamped = messages.map((m) => {
            const who = m.by_agent ?? "";
            if (!humanBy.has(who)) humanBy.set(who, isHuman(who));
            return {
                ...m,
                author_is_human: humanBy.get(who) === true,
                ...(awaiting.has(m.ticket_id ?? m.id) ? { ticket_awaiting_moderation: true } : {}),
            };
        });
        return { consumer_id, project: proj, count: unreadCount(consumer_id, proj), messages: withTags(stamped) };
    },
});

/** How many unread events the consumer has, in one project or all. */
defineMethod({
    name: "unread.count",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), project }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const proj = p.project ?? null;
        return { consumer_id, project: proj, count: unreadCount(consumer_id, proj) };
    },
});

/**
 * Mark read: one event (`message_id`), a project up to an id (`up_to_id`), a
 * whole project (`all`), or every project (`all_projects`, #1185). Another
 * consumer's backlog, or `delete` (drop instead of mark), is a human
 * moderator's gesture (local socket or the web UI).
 */
defineMethod({
    name: "unread.mark_read",
    who: ["human", "agent"],
    params: z.object({
        consumer_id: z.string().optional(),
        project: z.string().optional(),
        message_id: z.number().int().optional(),
        up_to_id: z.number().int().optional(),
        all: z.boolean().optional(),
        all_projects: z.boolean().optional(),
        delete: z.boolean().optional(),
    }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const human = caller.transport === "uds" || caller.kind === "human";
        if ((consumer_id !== caller.consumer_id || p.delete === true) && !human) {
            throw new Refusal(403, "targeting another consumer or delete requires a human moderator (local CLI or the web UI)", ERROR_CODES.MODERATOR_ONLY);
        }
        if (p.all_projects === true) {
            return { consumer_id, all_projects: true, deleted: p.delete === true, ...prunePings(consumer_id, { del: p.delete === true }) };
        }
        if (p.delete === true && p.project !== undefined) {
            return { consumer_id, project: p.project, deleted: true, ...prunePings(consumer_id, { project: p.project, del: true }) };
        }
        if (p.message_id !== undefined) {
            return { consumer_id, message_id: p.message_id, ...markMessageSeen(consumer_id, p.message_id) };
        }
        if (p.up_to_id !== undefined) {
            if (p.project === undefined) throw new Refusal(400, "project required when up_to_id is set");
            return { consumer_id, project: p.project, up_to_id: p.up_to_id, ...markSeenUpToForProject(consumer_id, p.project, p.up_to_id) };
        }
        if (p.all === true) {
            if (p.project === undefined) throw new Refusal(400, "project required when all:true");
            return { consumer_id, project: p.project, ...markAllSeenForProject(consumer_id, p.project) };
        }
        throw new Refusal(400, "provide message_id (single ack), up_to_id with project (bulk ack up to id), or all:true with project (ack everything delivered)");
    },
});

/** How many of an author's tickets still wait for moderation. */
defineMethod({
    name: "message.pending_count",
    who: ["human", "agent"],
    params: z.object({ by_agent: z.string().optional() }),
    run: (caller, p) => {
        const by_agent = whose(caller, p.by_agent);
        return { by_agent, count: pendingTicketsByAuthor(by_agent) };
    },
});

/**
 * #2164 — the three counters the MCP server stamps on every tool answer, in
 * one call: unread in the project, unread pings, own tickets awaiting
 * moderation.
 */
defineMethod({
    name: "consumer.micro_status",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), project, by_agent: z.string().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const proj = p.project ?? null;
        return {
            consumer_id,
            project: proj,
            unread_project: proj ? unreadCount(consumer_id, proj) : 0,
            unread_pings: unreadPingCount(consumer_id),
            my_pending: pendingTicketsByAuthor(p.by_agent ?? consumer_id),
        };
    },
});

/** The consumer's pings, newest first; `unread` keeps only the unseen. */
defineMethod({
    name: "ping.list",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), unread: flag, limit: z.coerce.number().int().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const pings = listPings({ recipient: consumer_id, unreadOnly: p.unread === true, limit: p.limit ?? 100 });
        return { consumer_id, count: pings.length, pings };
    },
});

/** How many unseen pings the consumer has. */
defineMethod({
    name: "ping.count",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        return { consumer_id, unread: unreadPingCount(consumer_id) };
    },
});

/** Mark the consumer's pings read: up to an id, or all. */
defineMethod({
    name: "ping.mark_read",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), all: z.boolean().optional(), up_to_id: z.number().int().optional() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        const all = p.all === true;
        if (!all && p.up_to_id === undefined) throw new Refusal(400, "provide up_to_id or all=true");
        return { consumer_id, ...markPingsRead({ recipient: consumer_id, all, upToId: p.up_to_id }) };
    },
});

/**
 * #786 — a backlog wake just named this ticket for the consumer: the
 * per-consumer cooldown starts again.
 */
defineMethod({
    name: "backlog.record_wake",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional(), ticket_id: z.number().int() }),
    run: (caller, p) => {
        const consumer_id = whose(caller, p.consumer_id);
        recordBacklogWake(consumer_id, p.ticket_id);
        return { consumer_id, ticket_id: p.ticket_id, recorded: true };
    },
});
