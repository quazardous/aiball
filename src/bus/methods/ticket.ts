/** #3063 — a ticket: its read, and the gestures on it (owner, hold, snooze, move, milestone). */
import { z } from "zod";
import { moderationRefusal } from "../../moderation-gate.js";
import { authorOf, consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { id } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import { assignWindowSec } from "../../autopoll/config.js";
import { claimProtectedUntil } from "../../db/claim-hold.js";
import { claimsToAutoRelease } from "../../db/assignment-gate.js";
import { insertTypedRelation, isHuman, lineageWouldCycle, listTypedRelationsForTicket, setTicketAssignment, setTicketClaim, ticketSelfLastActivity, ticketsClaimedBy } from "../../db.js";
import { RELATION_KINDS, type RelationKind, isRelationKind, relationAxis } from "../../relations.js";
import { listProjectSubscribers } from "../../db/subscriptions.js";
import { submitMessage } from "../../messages.js";
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
import { withTagsOne } from "../../queries/decorate.js";
import { ticketStateAfter } from "../../queries/tickets.js";

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

/**
 * #418: assign or claim a ticket. Without `assignee` (or naming the caller),
 * the caller claims it; naming someone else pushes it to them, a human's
 * gesture. The assignee is subscribed. A live assignment takes the ticket out
 * of the other consumers' actionable pool until it lapses, is released, or the
 * ticket closes.
 */
defineMethod({
    name: "ticket.assign",
    who: ["human", "agent"],
    params: z.looseObject({ id, assignee: z.any().optional() }),
    run: (ctx, p) => {
    const id = p.id;
    const caller = consumerIdOf(ctx);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
    const rawAssignee = typeof p.assignee === "string" ? p.assignee.trim() : "";
    const target = rawAssignee || caller; // no assignee → self-claim
    const isClaim = target === caller;
    if (!isClaim && !isHuman(caller)) {
        throw new Refusal(403, "assigning another consumer is moderator-only (an agent can only claim for itself)", ERROR_CODES.MODERATOR_ONLY);
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
    // #3237 — a refusal, as everywhere else: it used to come back as a 200
    // carrying `{ error }`, which a client (the MCP's ticket_claim) reported as
    // a claim made.
    const claimRefusal = isClaim ? moderationRefusal("claim", t, { human: isHuman(caller) }) : null; // #3249
    if (claimRefusal) throw new Refusal(claimRefusal.status, claimRefusal.error, claimRefusal.code);
    // #2241 — an agent claims only within its scope: a cto agent `roadmap` and
    // `milestone` tickets, a coder agent tasks. Same claim, different scope. A
    // human is not restricted, and neither is a moderator's push-assignment.
    // Covers MCP `ticket_claim({ticket_id})`, which reaches here directly; the
    // zero-arg form already picks from the scoped actionable pool.
    if (isClaim && !isHuman(caller) && !seesLevel(caller, t.level)) {
        throw new Refusal(403, `#${t.id} is a ${t.level ?? "task"} ticket, and this agent works on ${(levelsVisibleTo(caller) ?? []).join(" and ")} tickets only`, ERROR_CODES.LEVEL_READ_ONLY);
    }
    // #2379 david `prrg57` — "claim est une version faible de assign… tant qu'un
    // agent est actif sur un ticket son claim est protégé pendant X minutes, un
    // autre agent ne peut pas claim un ticket protégé, le assign supplante le
    // claim". Until now a claim by id went through on a ticket someone else held:
    // the holder lost it without a word, and the thread kept no trace. A human
    // still takes any ticket — moderating is the job.
    let takenOverFrom: string | null = null;
    if (isClaim && !isHuman(caller)) {
        if (t.assignee && t.assignee !== caller) {
            throw new Refusal(409, `#${t.id} is assigned to ${t.assignee} — an assignment supersedes a claim. Ask on the thread, or have a human reassign it.`, ERROR_CODES.TICKET_ASSIGNED);
        }
        if (t.claimant && t.claimant !== caller) {
            const until = claimProtectedUntil(t.claimant, t.id, t.claimed_at ?? null, t.project);
            if (until && until > Date.now()) {
                throw new Refusal(409, `#${t.id} is held by ${t.claimant}, who is working on it — protected until ${new Date(until).toISOString()}. Ask on the thread, or come back after that.`, ERROR_CODES.TICKET_HELD);
            }
            // Past the protection the ticket is takeable: a forgotten claim must
            // not freeze it. But the take-over is said, so its holder hears it.
            takenOverFrom = t.claimant;
        }
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
    if (takenOverFrom) {
        // A structural event: it says what happened and reaches the former
        // holder through the usual fan-out (a claim subscribes its holder to the
        // thread). It is not a comment — whose turn it is does not move.
        submitMessage({
            project: t.project,
            kind: "claim_taken_over",
            ticket_id: id,
            parent_id: id,
            body: `${caller} took over the claim held by ${takenOverFrom}, whose protection had lapsed.`,
            by_agent: caller,
        });
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
    return {
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
    };
    },
});

/**
 * Relate two tickets (#B.123 / #275): child_of / parent_of (a lineage, kept a
 * tree), depends_on / blocks, related. A human, the reporter of either
 * ticket, a project-owner of either project, or for depends_on / blocks the
 * agent either is assigned to. The same relation twice is a no-op.
 */
defineMethod({
    name: "ticket.relate",
    who: ["human", "agent"],
    params: z.looseObject({ id }),
    run: (ctx, p) => {
    const id = p.id;
    if (!Number.isFinite(id)) throw new Refusal(400, "ticket id required");
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
    const body = p as { target_ticket_id?: number; kind?: string; axis_kind?: string };
    const target = Number(body.target_ticket_id);
    if (!Number.isFinite(target) || target <= 0) {
        throw new Refusal(400, "target_ticket_id required (positive integer)");
    }
    if (target === id) {
        throw new Refusal(400, "a ticket cannot relate to itself");
    }
    const kindStr = typeof body.kind === "string" ? body.kind : "";
    if (!isRelationKind(kindStr)) {
        throw new Refusal(400, `kind must be one of ${RELATION_KINDS.join(", ")}`);
    }
    const targetTicket = getMessage(target);
    if (!targetTicket || targetTicket.kind !== "ticket_created") {
        throw new Refusal(404, `target ticket #${target} not found`, ERROR_CODES.TICKET_NOT_FOUND);
    }
    const caller = consumerIdOf(ctx);
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
        throw new Refusal(403, `only a registered human moderator, the reporter of #${id} (${t.by_agent}) / #${target} (${targetTicket.by_agent}), a project-owner of either project, or (for depends_on / blocks) the agent either ticket is assigned to can relate them`);
    }
    // Anti-cycle (#275): lineage (child_of/parent_of) must stay a DAG.
    // Reject an edge that would close a loop. parent_of is the mirror of
    // child_of, so swap (child, parent) for the check.
    if (kindStr === "child_of" && lineageWouldCycle(id, target)) {
        throw new Refusal(409, `#${id} child_of #${target} would create a lineage cycle`, ERROR_CODES.RELATION_CYCLE);
    }
    if (kindStr === "parent_of" && lineageWouldCycle(target, id)) {
        throw new Refusal(409, `#${id} parent_of #${target} would create a lineage cycle`, ERROR_CODES.RELATION_CYCLE);
    }
    // #1468 — an `ignored` tombstone may be scoped to ONE axis via `axis_kind`
    // (the kind whose axis to remove: `depends_on` cuts the gate, leaving a
    // `parent_of` lineage to the same target alive). Omitted = the historical
    // target-scoped cut that removes every axis.
    const axisKindStr = typeof body.axis_kind === "string" ? body.axis_kind : "";
    if (axisKindStr && !isRelationKind(axisKindStr)) {
        throw new Refusal(400, `axis_kind must be one of ${RELATION_KINDS.join(", ")}`);
    }
    if (axisKindStr && kindStr !== "ignored") {
        throw new Refusal(400, "axis_kind only applies when removing a relation (kind=ignored)");
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
            return { ticket_id: id, event_id: null, noop: true, relations: before };
        }
    } else if (before.some((r) => r.target_ticket_id === target && r.kind === kindStr)) {
        const dup = before.find((r) => r.target_ticket_id === target && r.kind === kindStr)!;
        return { ticket_id: id, event_id: dup.last_event_id, noop: true, relations: before };
    }
    const event = insertTypedRelation({
        source_ticket_id: id,
        target_ticket_id: target,
        relation_kind: kindStr as RelationKind,
        by_agent: caller,
        axis: cutAxis,
    });
    if (!event) throw new Refusal(500, "failed to create relation event");
    broadcast({ type: "message_created", data: event });
    return {
        ticket_id: id,
        event_id: event.id,
        relations: listTypedRelationsForTicket(id),
    };
    },
});
