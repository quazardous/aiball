/** #3063 — a ticket: its read, and the gestures on it (owner, hold, snooze, move, milestone). */
import { z } from "zod";
import { authorOf, consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { id } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import {
    getMessage,
    markTicketSeen,
    releaseTicketAssignment,
    releaseTicketClaim,
    setTicketOwner,
    setTicketPostpone,
    upsertTicketSubscription,
    type Message,
} from "../../db.js";
import { levelsVisibleTo, seesLevel } from "../../db/consumers.js";
import { milestonesOf, milestoneTargetRefusal, setTicketMilestone } from "../../db/milestones.js";
import { moveTicketTo } from "../../messages.js";
import { broadcast } from "../../ws.js";
import { withTagsOne } from "../../api/_helpers.js";
import { ticketStateAfter } from "../../api/tickets.js";

const MODERATOR = (what: string) => ({
    who: ["human"] as const,
    denied: { message: what, code: ERROR_CODES.MODERATOR_ONLY },
});

/** The ticket `id` names: its head, or a 404. */
function ticketOf(ticketId: number): Message {
    const t = getMessage(ticketId);
    if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
    return t;
}

/**
 * #352: change a ticket's owner (its reporter). The new owner is subscribed,
 * so they get the thread's pings; owner-bypass (close/reopen) follows it.
 * #3060 — the new owner is `owner`; `by_agent` is the author, the caller.
 */
defineMethod({
    name: "ticket.set_owner",
    ...MODERATOR("owner change is moderator-only"),
    params: z.object({ id, owner: z.unknown().optional(), by_agent: z.unknown().optional() }),
    run: (caller, p) => {
        authorOf(caller, p.by_agent);
        const owner = typeof p.owner === "string" ? p.owner.trim() : "";
        if (!owner) throw new Refusal(400, "owner required (a consumer id)");
        ticketOf(p.id);
        setTicketOwner(p.id, owner);
        upsertTicketSubscription(owner, p.id);
        return { ticket_id: p.id, owner, ticket: ticketStateAfter(p.id, consumerIdOf(caller)) };
    },
});

/**
 * #418 / #436: release what the caller holds, back to the shared pool: an
 * agent its own claim; the assignee or a moderator the assignment.
 */
defineMethod({
    name: "ticket.release",
    who: ["human", "agent"],
    params: z.object({ id }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        const t = ticketOf(p.id);
        const holdsClaim = t.claimant === me;
        const canReleaseAssignment = t.assignee === me || caller.kind === "human";
        if (!holdsClaim && !canReleaseAssignment) {
            throw new Refusal(403, "only the claimant, the assignee, or a moderator can release this ticket");
        }
        if (holdsClaim) releaseTicketClaim(p.id);
        if (canReleaseAssignment && t.assignee) releaseTicketAssignment(p.id);
        // #448: broadcast so the holder icon clears live.
        const updated = getMessage(p.id);
        if (updated) broadcast({ type: "message_edited", data: updated });
        return { ticket_id: p.id, released: true, ticket: ticketStateAfter(p.id, me) };
    },
});

/** Mark a ticket's events read for the caller, up to `up_to_id` when given (#B.191). */
defineMethod({
    name: "ticket.mark_read",
    who: ["human", "agent"],
    params: z.object({ id, up_to_id: z.unknown().optional() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        ticketOf(p.id);
        const upToId = p.up_to_id;
        const opts = typeof upToId === "number" && upToId > 0 ? { upTo: upToId } : undefined;
        const r = markTicketSeen(me, p.id, opts);
        return { ticket_id: p.id, ...(opts ? { up_to_id: upToId } : {}), ...r, ticket: ticketStateAfter(p.id, me) };
    },
});

/**
 * Snooze a ticket (#B.329) until `until` (ISO 8601): hidden from the open
 * inbox until then, when the reveal job brings it back. #784 — a human's
 * gesture only: an agent never deals with snooze.
 */
defineMethod({
    name: "ticket.postpone",
    ...MODERATOR("only a registered human moderator can snooze a ticket"),
    params: z.object({ id, until: z.unknown().optional() }),
    run: (caller, p) => {
        ticketOf(p.id);
        const until = p.until;
        if (typeof until !== "string" || !until) throw new Refusal(400, "until (ISO8601 string) required");
        const parsed = Date.parse(until);
        if (!Number.isFinite(parsed)) throw new Refusal(400, `invalid until "${until}" — expected ISO8601`);
        if (parsed <= Date.now()) throw new Refusal(400, "until must be in the future");
        const iso = new Date(parsed).toISOString();
        if (!setTicketPostpone(p.id, iso)) throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
        const updated = getMessage(p.id);
        if (updated) broadcast({ type: "message_edited", data: updated });
        return { ticket_id: p.id, postponed_until: iso, ticket: ticketStateAfter(p.id, consumerIdOf(caller)) };
    },
});

/** Bring a snoozed ticket back now. */
defineMethod({
    name: "ticket.unsnooze",
    ...MODERATOR("only a registered human moderator can unsnooze a ticket"),
    params: z.object({ id }),
    run: (caller, p) => {
        ticketOf(p.id);
        setTicketPostpone(p.id, null);
        const updated = getMessage(p.id);
        if (updated) broadcast({ type: "message_edited", data: updated });
        return { ticket_id: p.id, postponed_until: null, ticket: ticketStateAfter(p.id, consumerIdOf(caller)) };
    },
});

/**
 * Move a ticket, whole thread, to another project (#294): its reporter or a
 * human. The answer is the moved head (#2072), with the canonical row.
 */
defineMethod({
    name: "ticket.move",
    who: ["human", "agent"],
    params: z.object({ id, project: z.unknown().optional() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        const t = ticketOf(p.id);
        if (caller.kind !== "human" && t.by_agent !== me) {
            throw new Refusal(403, `only the ticket reporter (${t.by_agent}) or a registered human moderator can move this ticket`);
        }
        if (typeof p.project !== "string" || !p.project.trim()) throw new Refusal(400, "project (non-empty string) required");
        const target = p.project.trim();
        if (target === t.project) throw new Refusal(400, `ticket is already in project "${target}"`);
        const updated = moveTicketTo(p.id, target, me);
        return { ...updated, ticket: ticketStateAfter(p.id, me) };
    },
});

/**
 * #2910 — put a ticket in a milestone, move it to another, or take it out
 * (`milestone_id: null`). Planning: a human's gesture or a cto agent's.
 */
defineMethod({
    name: "ticket.set_milestone",
    who: ["human", "agent"],
    params: z.object({ id, milestone_id: z.unknown().optional() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        const t = ticketOf(p.id);
        const raw = p.milestone_id;
        if (raw !== null && !(Number.isInteger(raw) && (raw as number) > 0)) {
            throw new Refusal(400, "milestone_id must be a milestone ticket id, or null to take the ticket out of its milestone", ERROR_CODES.MILESTONE_INVALID);
        }
        if (caller.kind !== "human" && !seesLevel(me, "milestone")) {
            throw new Refusal(403, `setting a ticket's milestone is planning: a human's gesture or a cto agent's; this agent works on ${(levelsVisibleTo(me) ?? []).join(" and ")} tickets`, ERROR_CODES.LEVEL_READ_ONLY);
        }
        const refusal = milestoneTargetRefusal({ id: t.id, project: t.project, level: t.level ?? "task" }, raw as number | null);
        if (refusal) throw new Refusal(400, refusal.error, refusal.code);
        setTicketMilestone(p.id, raw as number | null);
        const updated = getMessage(p.id);
        if (updated) broadcast({ type: "message_edited", data: withTagsOne(updated) });
        return { ticket_id: p.id, milestone: milestonesOf([p.id]).get(p.id) ?? null };
    },
});
