/**
 * #2526 — POST /api/tickets: an external system files a ticket with an API key
 * holding the scope `tickets:create`.
 *
 * Moderation (david: "approuvé n'est pas le défaut, le défaut est la config
 * d'auto-approbation"): a ticket goes through the project's usual moderation —
 * its rules and strategy — like any post by that author. `approved: true` asks
 * for it approved at once; the key holder chooses, ticket by ticket. Its author is the key's
 * source (its label), never a field of the body, so a caller cannot file as
 * someone else. From there it is an ordinary ticket — fanned out to the owners,
 * in their backlog, claimable and closable.
 *
 * `external_id` makes retries safe: the same source sending the same id gets
 * the ticket it already created back (200), not a duplicate.
 *
 * `assignee` (david, on the plan: "il faut un assignee") hands the ticket to a
 * consumer of the project at creation, the way a human assigns one: it is
 * subscribed to the thread and pinged, so a crew agent waiting for its
 * assignments is woken by it.
 *
 * Like the signals route, the key is required on the Unix socket too: the
 * middleware trusts a socket caller without a token, so this route checks.
 */
import { Router, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { keyFor } from "./keys.js";
import { getDb } from "../db/connection.js";
import { getMessage } from "../db.js";
import * as schema from "../schema.js";
import { validateNewMessage } from "../messages.js";
import { fileTicket, isExtrasRefusal, SUBMIT_REFUSAL_STATUS, ticketExtras } from "../file-ticket.js";
import { isErrorCode } from "../domain.js";
import { refuse } from "./_helpers.js";
import { withTagsOne } from "../queries/decorate.js";

export const keyTicketsRouter = Router();

export const EXTERNAL_ID_MAX = 200;

/** The ticket this source already created under `externalId`, if any. */
function findByExternalId(source: string, externalId: string): number | null {
    const row = getDb().select({ id: schema.tickets.id }).from(schema.tickets)
        .where(and(
            eq(schema.tickets.byAgent, source),
            sql`json_extract(${schema.tickets.meta}, '$.external_id') = ${externalId}`,
        ))
        .get();
    return row?.id ?? null;
}

function recordExternalId(ticketId: number, externalId: string): void {
    const row = getDb().select({ meta: schema.tickets.meta }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
    let meta: Record<string, unknown> = {};
    try { meta = row?.meta ? JSON.parse(row.meta) as Record<string, unknown> : {}; } catch { /* rewrite below */ }
    meta.external_id = externalId;
    getDb().update(schema.tickets).set({ meta: JSON.stringify(meta) }).where(eq(schema.tickets.id, ticketId)).run();
}

keyTicketsRouter.post("/tickets", (req: Request, res: Response) => {
    const grant = keyFor(req, "tickets:create", "POST /api/tickets is for an API key with the scope tickets:create — agents and humans file tickets with POST /api/messages", "not-a-key");
    if ("status" in grant) return refuse(res, grant.status, grant.error, grant.code);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const project = typeof body.project === "string" ? body.project.trim() : "";
    if (!project) return refuse(res, 400, "project is required");
    if (!grant.projects.includes(project)) {
        return refuse(res, 403, `this key may not create tickets in ${project} — its projects: ${grant.projects.join(", ") || "none"}`);
    }

    let externalId: string | null = null;
    if (body.external_id !== undefined && body.external_id !== null) {
        if (typeof body.external_id !== "string" || !body.external_id.trim() || body.external_id.length > EXTERNAL_ID_MAX) {
            return refuse(res, 400, `external_id must be a non-empty string of at most ${EXTERNAL_ID_MAX} characters`);
        }
        externalId = body.external_id.trim();
        const existing = findByExternalId(grant.source, externalId);
        if (existing !== null) {
            const t = getDb().select().from(schema.tickets).where(eq(schema.tickets.id, existing)).get();
            return res.status(200).json({ id: existing, project: t?.project, title: t?.title, existing: true });
        }
    }

    // #3037 — tags and assignee are checked like every ticket's extras, before
    // anything is written; a key's assignee must already work on the project.
    const extras = ticketExtras(
        { tags: body.tags, assignee: body.assignee },
        project,
        grant.source,
        { assigneeRule: "subscriber" },
    );
    if (isExtrasRefusal(extras)) return refuse(res, extras.status, extras.error, extras.code);

    const v = validateNewMessage({
        kind: "ticket_created",
        project,
        title: body.title,
        body: body.body,
        priority: body.priority,
        intent: body.intent,
        by_agent: grant.source,
    });
    if ("error" in v) return refuse(res, 400, v.error);
    v.by_agent = grant.source;

    if (body.approved !== undefined && typeof body.approved !== "boolean") {
        return refuse(res, 400, "approved must be true or false");
    }
    let msg;
    try {
        msg = fileTicket(v, extras, grant.source, { preApprovedByKey: body.approved === true });
    } catch (err) {
        // #3248 — the refusals of the write path answer as on the bus (a project
        // gone since the key was scoped is a 400 PROJECT_NOT_FOUND, not a 500).
        const code = (err as { code?: string }).code ?? "";
        const status = SUBMIT_REFUSAL_STATUS[code];
        if (!status) throw err;
        return refuse(res, status, err instanceof Error ? err.message : String(err), isErrorCode(code) ? code : undefined);
    }
    if (externalId) recordExternalId(msg.id, externalId);
    const out = getMessage(msg.id) ?? msg;
    res.status(201).json({ ...withTagsOne(out), existing: false });
});
