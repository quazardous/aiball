/**
 * #3067 — the rarer calls of aiball's own clients, on the bus: a ticket's
 * payload zone (docs/PAYLOADS.md), its pending children, a consumer's
 * signals, a project's feed path; the board's config, the step timing report,
 * coupling a ticket to an upstream issue, and reloading the daemon's config.
 */
import { z } from "zod";
import { authorOf, consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { getMessage } from "../../db.js";
import { isTicketClosed, listMessages, listPendingChildren, listTypedRelationsForTicket, tagMessageAsStep, untagMessageStep } from "../../db/messages.js";
import { markTicketUnseen } from "../../db/pings.js";
import { listTicketSubscriptionsForTicket } from "../../db/subscriptions.js";
import { ticketStateAfter } from "../../api/tickets.js";
import { broadcast } from "../../ws.js";
import { isHuman } from "../../db/consumers.js";
import { readTicketPayload, readTicketPayloadRaw, revokeTicketPayload, writeTicketPayload } from "../../db/payloads.js";
import { canReadPayloadSecrets, payloadAccessState } from "../../db/ticket-payload.js";
import { ackSignal, listPendingSignals } from "../../db/signals.js";
import { applyModeration } from "../../api/moderation.js";
import { outboxPath } from "../../paths.js";
import { ERROR_CODES } from "../../domain.js";
import { findConfigUpwards, globalConfigPath, loadConfig } from "../../autopoll/config.js";
import { defaultPingsPath } from "../../claude-loop/state.js";
import { getStrategy, getUploadMaxBytes } from "../../db.js";
import { resolveFormatting } from "../../formatting.js";
import { listWaitCredits } from "../../db/wait-credit.js";
import { stepTimingReport, stepTimingRows } from "../../db/step-timing.js";
import { importUpstream, AlreadyCoupledError } from "../../upstream-import.js";
import { exportUpstream } from "../../upstream-export.js";
import { withTagsOne } from "../../api/_helpers.js";
import { reloadConfig } from "../../config-reload.js";

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

/**
 * #235 — the board's configuration a client reads once at boot: formatting,
 * strategy, upload limit, and (#160) the upstream bindings per project. The
 * YAML chain is re-read on each call (defaults, global, the daemon's cwd).
 */
defineMethod({
    name: "config.get",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => ({
        formatting: resolveFormatting({
            shippedDefaultsPath: defaultPingsPath(),
            globalConfigPath: globalConfigPath(),
            projectConfigPath: findConfigUpwards(process.cwd()),
        }),
        strategy: getStrategy(),
        uploadMaxBytes: getUploadMaxBytes(),
        upstream: loadConfig(process.cwd()).upstream,
    }),
});

/** #2629 — declared step delays against when the agent actually came back, with the wait credits. */
defineMethod({
    name: "step.timing",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional(), since_days: z.coerce.number().optional() }),
    run: (_caller, p) => {
        const project = p.project || null;
        const days = p.since_days;
        const since = days !== undefined && Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
        return { project, since, buckets: stepTimingReport(stepTimingRows({ project, since })), credits: listWaitCredits(project) };
    },
});

/** A ticket already mirroring the issue: 409, the ticket in `details.existing_ticket_id`. */
function coupledRefusal(err: unknown): Refusal {
    if (err instanceof AlreadyCoupledError) {
        return new Refusal(409, err.message, ERROR_CODES.ALREADY_IMPORTED, { existing_ticket_id: err.existingTicketId });
    }
    return new Refusal(400, err instanceof Error ? err.message : String(err));
}

/**
 * Upstream coupling — manual import: fetch an external issue (`gh#123`, which
 * needs a default binding, or `gh:owner/repo#123`) and file a ticket coupled
 * to it. Nothing here runs by itself.
 */
defineMethod({
    name: "ticket.import",
    who: ["human", "agent"],
    params: z.object({ project: z.string().optional(), ref: z.unknown().optional(), by_agent: z.unknown().optional() }),
    run: async (caller, p) => {
        const ref = typeof p.ref === "string" ? p.ref.trim() : "";
        if (!ref) throw new Refusal(400, "ref required (e.g. gh#123 or gh:owner/repo#123)");
        if (!p.project) throw new Refusal(400, "project required");
        const by_agent = authorOf(caller, p.by_agent);
        try {
            const { ticket, external, provider } = await importUpstream({ project: p.project, ref, by_agent });
            return { ticket: withTagsOne(ticket), external, provider };
        } catch (err) {
            throw coupledRefusal(err);
        }
    },
});

/**
 * Upstream coupling — manual export: open a NEW external issue from a ticket
 * and couple them. It writes to the remote: a client confirms first.
 */
defineMethod({
    name: "ticket.export",
    who: ["human", "agent"],
    params: z.object({ id: ticketId, kind: z.string().optional(), repo: z.string().optional(), by_agent: z.unknown().optional() }),
    run: async (caller, p) => {
        const by_agent = authorOf(caller, p.by_agent);
        try {
            const { ticket, external, provider } = await exportUpstream({ ticket_id: p.id, kind: p.kind, repo: p.repo, by_agent });
            return { ticket: withTagsOne(ticket), external, provider };
        } catch (err) {
            throw coupledRefusal(err);
        }
    },
});

/**
 * #2089 — reload the daemon's config in place (`aiball reload`). Local-trust,
 * not moderator: it replaces a signal to the pidfile, which any process of the
 * same uid could send, and the Unix socket is that same boundary. It re-reads a
 * config file and says what it read; a failure leaves the daemon up.
 */
defineMethod({
    name: "daemon.reload",
    who: ["human", "agent"],
    relayed: false,
    params: z.object({}),
    run: (caller) => {
        if (caller.transport !== "uds") {
            throw new Refusal(403, "daemon reload is local-only — run `aiball reload` on the machine running the daemon (it goes over the Unix socket)", ERROR_CODES.FORBIDDEN);
        }
        try {
            return { reloaded: true, ...reloadConfig() };
        } catch (e) {
            throw new Refusal(500, (e as Error).message, ERROR_CODES.INTERNAL, { reloaded: false });
        }
    },
});

/** Mark a ticket unread again for the caller; the answer carries its row. */
defineMethod({
    name: "ticket.mark_unread",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => {
        const t = ticketOf(p.id);
        const me = consumerIdOf(caller);
        return { ticket_id: t.id, ...markTicketUnseen(me, t.id), ticket: ticketStateAfter(t.id, me) };
    },
});

/**
 * #352 — a ticket's explicit subscriptions, follows and mutes, for the
 * moderator who manages who else is pinged (owners pinged by their role are
 * not listed).
 */
defineMethod({
    name: "ticket.subscribers",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => {
        if (!isHuman(consumerIdOf(caller))) throw new Refusal(403, "subscription management is moderator-only", ERROR_CODES.MODERATOR_ONLY);
        return { ticket_id: p.id, subscriptions: listTicketSubscriptionsForTicket(p.id) };
    },
});

/**
 * #2383 — mark a ticket as a step from the ticket itself: its latest comment,
 * which must be an agent's (a human's last word would leave the ticket where
 * it is). A human moderator's gesture.
 */
function stepTicket(caller: Caller, id: number, tag: boolean) {
    const me = consumerIdOf(caller);
    if (!isHuman(me)) throw new Refusal(403, "only a registered human moderator can mark a ticket as a step", ERROR_CODES.MODERATOR_ONLY);
    ticketOf(id);
    let latest: ReturnType<typeof getMessage> = null;
    for (const m of listMessages({ kind: "comment_added", ticket_id: id })) {
        if (m.status !== "approved") continue;
        if (!latest || m.id > latest.id) latest = m;
    }
    if (!latest) throw new Refusal(409, "this ticket has no comment to mark as a step");
    if (!latest.by_agent || isHuman(latest.by_agent)) {
        throw new Refusal(409, "the thread's last word is a human's — tagging an older comment would not move the ticket; answer the agent, or tag its own comment in the thread");
    }
    let updated: ReturnType<typeof getMessage>;
    try {
        updated = tag ? tagMessageAsStep(latest.id, me) : untagMessageStep(latest.id);
    } catch (e) {
        throw new Refusal(409, e instanceof Error ? e.message : String(e));
    }
    if (!updated) throw new Refusal(404, "not found");
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    return decorated;
}

/** Tag the ticket's latest comment, an agent's, as a step. */
defineMethod({
    name: "ticket.step",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => stepTicket(caller, p.id, true),
});

/** Remove that step tag. */
defineMethod({
    name: "ticket.unstep",
    who: ["human", "agent"],
    params: z.object({ id: ticketId }),
    run: (caller, p) => stepTicket(caller, p.id, false),
});
