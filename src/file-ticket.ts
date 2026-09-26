/**
 * #3037 — filing a ticket in one call, with what it is filed with: its tags,
 * assignee, milestone and level (its parent already rode on the message).
 *
 * Every client used to create the ticket, then send one call per extra — tags,
 * assign, milestone, a level edit — and handle "the ticket exists, but not all
 * of it". Here the extras are all checked first (`ticketExtras`), and a refusal
 * names the field and writes nothing. Then the ticket and its extras land in
 * one transaction (`fileTicket`), applied before anything announces the new
 * ticket: one `ticket_created`, which pings, broadcasts and the automation
 * rules all see whole.
 *
 * The rules are the ones each extra already had on its own route:
 * - a tag must exist (the project's, else a global one);
 * - an assignment is a moderator's push (the API-key route keeps its own
 *   rule: the assignee must be a consumer of the project);
 * - a level other than `task` is set by a human moderator;
 * - a milestone is planning — a human's or an agent's that works on
 *   milestones — and must be an unreleased milestone of the same project;
 * - a parent must be an existing ticket.
 */
import { getDb } from "./db/connection.js";
import * as schema from "./schema.js";
import { eq } from "drizzle-orm";
import { getConsumer, isHuman, levelsVisibleTo, seesLevel } from "./db/consumers.js";
import { getMessage, type Message, type NewMessage } from "./db.js";
import { getTag, getTagByName, setMessageTags } from "./db/tags.js";
import { setTicketAssignment } from "./db/tickets.js";
import { listProjectSubscribers, upsertTicketSubscription } from "./db/subscriptions.js";
import { insertPing } from "./db/pings.js";
import { milestoneTargetRefusal, setTicketMilestone } from "./db/milestones.js";
import { ERROR_CODES, TICKET_LEVELS, type ErrorCode, type TicketLevel } from "./domain.js";
import { submitMessage, type SubmitOpts } from "./messages.js";

export interface TicketExtras {
    tagIds: number[];
    assignee: string | null;
    milestone: number | null;
    level: TicketLevel | null;
}

export interface ExtrasRefusal {
    status: number;
    error: string;
    code: ErrorCode;
}

export const NO_EXTRAS: TicketExtras = { tagIds: [], assignee: null, milestone: null, level: null };

/** Who may assign at creation: a moderator (the default), or, for an API key, a consumer of the project. */
export type AssigneeRule = "moderator" | "subscriber";

/**
 * Read and check a new ticket's extras from a request body. Nothing is
 * written. `caller` is who files it.
 */
export function ticketExtras(
    body: Record<string, unknown>,
    project: string,
    caller: string,
    opts: { assigneeRule?: AssigneeRule } = {},
): TicketExtras | ExtrasRefusal {
    const human = isHuman(caller);

    if (body.parent_id !== undefined && body.parent_id !== null) {
        const parent = typeof body.parent_id === "number" ? getMessage(body.parent_id) : null;
        if (!parent || parent.kind !== "ticket_created") {
            return { status: 404, error: `parent_id: #${String(body.parent_id)} is not a ticket`, code: ERROR_CODES.TICKET_NOT_FOUND };
        }
    }

    const tagIds: number[] = [];
    if (body.tags !== undefined && body.tags !== null) {
        if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string" && typeof t !== "number")) {
            return { status: 400, error: "tags must be a list of tag names or ids", code: ERROR_CODES.BAD_REQUEST };
        }
        for (const ref of body.tags as (string | number)[]) {
            const tag = typeof ref === "number" ? getTag(ref) : getTagByName(ref, project) ?? getTagByName(ref);
            if (!tag) return { status: 400, error: `tags: unknown tag ${String(ref)}`, code: ERROR_CODES.TAG_UNKNOWN };
            if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
        }
    }

    let assignee: string | null = null;
    if (body.assignee !== undefined && body.assignee !== null && body.assignee !== "") {
        if (typeof body.assignee !== "string" || !body.assignee.trim()) {
            return { status: 400, error: "assignee must be a consumer id", code: ERROR_CODES.BAD_REQUEST };
        }
        assignee = body.assignee.trim();
        if ((opts.assigneeRule ?? "moderator") === "subscriber") {
            // A key hands work to one of the project's consumers, it does not recruit someone new.
            if (!listProjectSubscribers(project).includes(assignee)) {
                return { status: 400, error: `${assignee} is not subscribed to ${project} — assign a consumer of the project`, code: ERROR_CODES.BAD_REQUEST };
            }
        } else {
            if (!human) {
                return { status: 403, error: "assignee: assigning is a moderator's push — an agent files the ticket, then claims it if it takes it", code: ERROR_CODES.MODERATOR_ONLY };
            }
            if (!getConsumer(assignee)) {
                return { status: 400, error: `assignee: no consumer ${assignee}`, code: ERROR_CODES.CONSUMER_NOT_FOUND };
            }
        }
    }

    let level: TicketLevel | null = null;
    if (body.level !== undefined && body.level !== null) {
        if (typeof body.level !== "string" || !(TICKET_LEVELS as readonly string[]).includes(body.level)) {
            return { status: 400, error: `level must be one of ${TICKET_LEVELS.join(", ")}`, code: ERROR_CODES.BAD_REQUEST };
        }
        level = body.level as TicketLevel;
        if (level !== "task" && !human) {
            return { status: 403, error: "level: a ticket's level is set by a human moderator only", code: ERROR_CODES.MODERATOR_ONLY };
        }
    }

    let milestone: number | null = null;
    if (body.milestone !== undefined && body.milestone !== null) {
        if (!(Number.isInteger(body.milestone) && (body.milestone as number) > 0)) {
            return { status: 400, error: "milestone must be a milestone ticket id", code: ERROR_CODES.MILESTONE_INVALID };
        }
        if (!human && !seesLevel(caller, "milestone")) {
            return {
                status: 403,
                error: `milestone: putting a ticket in a milestone is planning, a human's gesture or a cto agent's; this agent works on ${(levelsVisibleTo(caller) ?? []).join(" and ")} tickets`,
                code: ERROR_CODES.LEVEL_READ_ONLY,
            };
        }
        const refusal = milestoneTargetRefusal({ id: null, project, level: level ?? "task" }, body.milestone as number);
        if (refusal) return { status: 400, error: `milestone: ${refusal.error}`, code: refusal.code };
        milestone = body.milestone as number;
    }

    return { tagIds, assignee, milestone, level };
}

export function isExtrasRefusal(v: TicketExtras | ExtrasRefusal): v is ExtrasRefusal {
    return "code" in v;
}

/** The extras, on the ticket just inserted, before it is announced. */
function applyExtras(msg: Message, extras: TicketExtras, caller: string): Message {
    const id = msg.id;
    if (extras.level) getDb().update(schema.tickets).set({ level: extras.level }).where(eq(schema.tickets.id, id)).run();
    if (extras.milestone !== null) setTicketMilestone(id, extras.milestone);
    if (extras.tagIds.length) setMessageTags(id, extras.tagIds, caller);
    if (extras.assignee) {
        setTicketAssignment(id, extras.assignee, caller);
        upsertTicketSubscription(extras.assignee, id);
        // The creation fan-out reaches the owners; a follower or crew assignee
        // is not among them. Idempotent: an owner is not pinged twice.
        insertPing(extras.assignee, { id, kind: msg.kind, intent: msg.intent }, caller);
    }
    return getMessage(id) ?? msg;
}

/**
 * File a checked ticket with its extras, all or nothing: the ticket, its
 * extras and its events land in one transaction. `v` is a validated
 * `ticket_created`, `caller` who files it.
 */
export function fileTicket(v: NewMessage, extras: TicketExtras, caller: string, opts: SubmitOpts = {}): Message {
    return getDb().transaction(() => submitMessage(v, {
        ...opts,
        beforeAnnounce: (msg) => applyExtras(msg, extras, caller),
    }));
}
