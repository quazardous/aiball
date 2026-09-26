/**
 * #3067 — the rarer calls of aiball's own clients, on the bus: a ticket's
 * payload zone (docs/PAYLOADS.md), its pending children, a consumer's
 * signals, and a project's feed path.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { getMessage } from "../../db.js";
import { isTicketClosed, listPendingChildren, listTypedRelationsForTicket } from "../../db/messages.js";
import { isHuman } from "../../db/consumers.js";
import { readTicketPayload, readTicketPayloadRaw, revokeTicketPayload, writeTicketPayload } from "../../db/payloads.js";
import { canReadPayloadSecrets, payloadAccessState } from "../../db/ticket-payload.js";
import { ackSignal, listPendingSignals } from "../../db/signals.js";
import { applyModeration } from "../../api/moderation.js";
import { outboxPath } from "../../paths.js";
import { ERROR_CODES } from "../../domain.js";

type TicketRow = { id: number; kind: string; by_agent?: string | null; assignee?: string | null };

function ticketOf(id: number): TicketRow {
    const t = getMessage(id) as TicketRow | undefined;
    if (!t || t.kind !== "ticket_created") throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
    return t;
}

/** Owner, assignee or reporter, not the claimant: claim is self-service (see `canReadPayloadSecrets`). */
function guardSecretAccess(caller: Caller, t: TicketRow): void {
    const me = consumerIdOf(caller);
    if (!canReadPayloadSecrets(t, me, isHuman(me))) {
        throw new Refusal(403, "only the reporter, the assignee or a moderator can reach this payload's values");
    }
}

const ticketId = z.coerce.number().int().positive();

/** #2109 — a ticket's payload, filtered: every key, values only where the schema says. No secret in it. */
defineMethod({
    name: "ticket.payload",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (_caller, p) => {
        const t = ticketOf(p.id);
        const view = readTicketPayload(t.id);
        if (!view) throw new Refusal(404, "this ticket carries no payload");
        return { ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) };
    },
});

/** #2109 — deposit or replace a ticket's payload; `schema` names the keys that are public. */
defineMethod({
    name: "ticket.set_payload",
    who: ["human", "agent"],
    params: z.object({ id: ticketId, payload: z.unknown(), schema: z.unknown().optional() }),
    run: (caller, p) => {
        const t = ticketOf(p.id);
        guardSecretAccess(caller, t);
        if (isTicketClosed(t.id)) throw new Refusal(400, "this ticket is closed — reopen it before depositing a payload");
        const payload = p.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Refusal(400, "`payload` must be a JSON object of key -> value");
        }
        const schema = p.schema;
        if (schema !== undefined && schema !== null) {
            if (!Array.isArray(schema) || schema.some((k) => typeof k !== "string")) {
                throw new Refusal(400, "`schema` must be an array of key names that are public");
            }
            // A public key absent from the payload is almost always a typo.
            const unknownKeys = (schema as string[]).filter((k) => !Object.prototype.hasOwnProperty.call(payload, k));
            if (unknownKeys.length > 0) throw new Refusal(400, `schema names keys absent from the payload: ${unknownKeys.join(", ")}`);
        }
        const view = writeTicketPayload(t.id, payload as Record<string, unknown>, (schema as string[] | null | undefined) ?? [], consumerIdOf(caller));
        return { ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) };
    },
});

/**
 * #2109 — the values themselves, the deliberate gesture. A closed ticket ends
 * access (409), a revoked payload has none left (410); either refusal says
 * which in `details.access`.
 */
defineMethod({
    name: "ticket.dump_payload",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => {
        const t = ticketOf(p.id);
        guardSecretAccess(caller, t);
        const view = readTicketPayload(t.id);
        if (!view) throw new Refusal(404, "this ticket carries no payload");
        const access = payloadAccessState({ closed: isTicketClosed(t.id) }, view);
        if (access === "revoked") throw new Refusal(410, "this payload was revoked — its values are gone", ERROR_CODES.GONE, { access });
        if (access === "ticket-closed") throw new Refusal(409, "this ticket is closed — reopen it to reach the payload", ERROR_CODES.CONFLICT, { access });
        const values = readTicketPayloadRaw(t.id);
        if (!values) throw new Refusal(404, "this ticket carries no payload");
        return { ticket_id: t.id, payload: values, access };
    },
});

/** #2109 — revoke: the values are destroyed, the trace that they existed stays. */
defineMethod({
    name: "ticket.revoke_payload",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => {
        const t = ticketOf(p.id);
        guardSecretAccess(caller, t);
        const view = revokeTicketPayload(t.id, consumerIdOf(caller));
        if (!view) throw new Refusal(404, "this ticket carries no payload");
        return { ...view, access: payloadAccessState({ closed: isTicketClosed(t.id) }, view) };
    },
});

/** #2180 — a ticket's pending `child_of` children, one level, with who attached each and when. */
defineMethod({
    name: "ticket.pending_children",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (_caller, p) => {
        const t = ticketOf(p.id);
        return { ticket_id: t.id, children: listPendingChildren(t.id) };
    },
});

/**
 * #2180 — approve exactly the pending children named (human only: it is
 * moderation). Anything that is not, or no longer, a pending child of this
 * ticket comes back in `skipped`, never approved.
 */
defineMethod({
    name: "ticket.approve_pending_children",
    who: ["human", "agent"],
    params: z.object({ id: ticketId, ticket_ids: z.unknown() }),
    run: (caller, p) => {
        const t = ticketOf(p.id);
        const me = consumerIdOf(caller);
        if (!isHuman(me)) throw new Refusal(403, "approving pending children is moderation — a registered human moderator only", ERROR_CODES.MODERATOR_ONLY);
        const raw = p.ticket_ids;
        if (!Array.isArray(raw) || raw.length === 0 || raw.some((n) => !Number.isInteger(n) || (n as number) <= 0)) {
            throw new Refusal(400, "ticket_ids (a non-empty array of ticket ids — the ones you were shown) required");
        }
        const pending = new Set(listPendingChildren(t.id).map((c) => c.ticket_id));
        const children = new Set(listTypedRelationsForTicket(t.id).filter((r) => r.kind === "parent_of").map((r) => r.target_ticket_id));
        const approved: number[] = [];
        const skipped: Array<{ ticket_id: number; reason: string }> = [];
        for (const childId of new Set(raw as number[])) {
            const child = getMessage(childId);
            if (!pending.has(childId) || !child || child.status !== "pending") {
                skipped.push({ ticket_id: childId, reason: children.has(childId) ? `not pending (${child?.status ?? "missing"})` : `not a child of #${t.id}` });
                continue;
            }
            if (applyModeration(child, "approved", me)) approved.push(childId);
            else skipped.push({ ticket_id: childId, reason: "not found" });
        }
        return { ticket_id: t.id, approved, skipped };
    },
});

/** #2255 — the signals waiting for the caller; a human may look at another consumer's. */
defineMethod({
    name: "signal.list",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().optional() }),
    run: (caller, p) => {
        const me = consumerIdOf(caller);
        const asked = p.consumer_id || me;
        if (asked !== me && !isHuman(me)) throw new Refusal(403, "only a human may read another consumer's signals", ERROR_CODES.MODERATOR_ONLY);
        return { consumer_id: asked, signals: listPendingSignals(asked) };
    },
});

/** #2255 — the caller's loop injected the signal: stop delivering it. */
defineMethod({
    name: "signal.ack",
    who: ["human", "agent"],
    params: z.object({ id: z.coerce.number().int() }),
    run: (caller, p) => {
        if (!ackSignal(p.id, consumerIdOf(caller))) throw new Refusal(404, "no pending delivery of this signal for you");
        return { id: p.id, acked: true };
    },
});

/** The file a project's feed is written to, for `aiball feed-path`. */
defineMethod({
    name: "project.feed_path",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional() }),
    run: (_caller, p) => {
        if (!p.project) throw new Refusal(400, "project query required");
        try {
            return { path: outboxPath(p.project) };
        } catch (e) {
            throw new Refusal(400, (e as Error).message);
        }
    },
});
