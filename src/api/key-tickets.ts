/**
 * #2526 — POST /api/tickets: an external system files a ticket with an API key
 * holding the scope `tickets:create`.
 *
 * The ticket is created already approved: the moderation happened once, when a
 * human granted the scope for the key's projects. Its author is the key's
 * source (its label), never a field of the body, so a caller cannot file as
 * someone else. From there it is an ordinary ticket — fanned out to the owners,
 * in their backlog, claimable and closable.
 *
 * `external_id` makes retries safe: the same source sending the same id gets
 * the ticket it already created back (200), not a duplicate.
 *
 * Like the signals route, the key is required on the Unix socket too: the
 * middleware trusts a socket caller without a token, so this route checks.
 */
import { Router, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { readBearerToken, type AuthenticatedRequest } from "../auth.js";
import { getTokenAndTouch } from "../db/tokens.js";
import { keyProjects, keyScopes } from "../db/signal-keys.js";
import { getDb } from "../db/connection.js";
import { getTagByName, setMessageTags } from "../db/tags.js";
import * as schema from "../schema.js";
import { submitMessage, validateNewMessage } from "../messages.js";
import { withTagsOne } from "./_helpers.js";

export const keyTicketsRouter = Router();

export const EXTERNAL_ID_MAX = 200;

type KeyGrant = { source: string; projects: string[] };

function keyGrantOf(req: Request): KeyGrant | { status: 401 | 403; error: string } {
    const ar = req as AuthenticatedRequest;
    if (ar.token_kind === "signal" && ar.signal_source) {
        if (!ar.signal_scopes?.includes("tickets:create")) return { status: 403, error: "this key lacks the scope tickets:create" };
        return { source: ar.signal_source, projects: ar.signal_projects ?? [] };
    }
    const onSocket = (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const bearer = onSocket ? readBearerToken(req) : null;
    if (onSocket && bearer) {
        const row = getTokenAndTouch(bearer);
        if (!row) return { status: 401, error: "invalid or expired API key" };
        if (row.kind === "signal") {
            if (!keyScopes(row).includes("tickets:create")) return { status: 403, error: "this key lacks the scope tickets:create" };
            return { source: row.label ?? "unnamed", projects: keyProjects(row) };
        }
    }
    return {
        status: 403,
        error: "POST /api/tickets is for an API key with the scope tickets:create — agents and humans file tickets with POST /api/messages",
    };
}

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
    const grant = keyGrantOf(req);
    if ("status" in grant) return res.status(grant.status).json({ error: grant.error });
    const body = (req.body ?? {}) as Record<string, unknown>;

    const project = typeof body.project === "string" ? body.project.trim() : "";
    if (!project) return res.status(400).json({ error: "project is required" });
    if (!grant.projects.includes(project)) {
        return res.status(403).json({ error: `this key may not create tickets in ${project} — its projects: ${grant.projects.join(", ") || "none"}` });
    }

    let externalId: string | null = null;
    if (body.external_id !== undefined && body.external_id !== null) {
        if (typeof body.external_id !== "string" || !body.external_id.trim() || body.external_id.length > EXTERNAL_ID_MAX) {
            return res.status(400).json({ error: `external_id must be a non-empty string of at most ${EXTERNAL_ID_MAX} characters` });
        }
        externalId = body.external_id.trim();
        const existing = findByExternalId(grant.source, externalId);
        if (existing !== null) {
            const t = getDb().select().from(schema.tickets).where(eq(schema.tickets.id, existing)).get();
            return res.status(200).json({ id: existing, project: t?.project, title: t?.title, existing: true });
        }
    }

    // Tags are resolved before anything is written: an unknown name refuses the
    // whole request rather than leaving a ticket without the tags it asked for.
    const tagIds: number[] = [];
    if (body.tags !== undefined) {
        if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
            return res.status(400).json({ error: "tags must be a list of tag names" });
        }
        for (const name of body.tags as string[]) {
            const tag = getTagByName(name, project) ?? getTagByName(name);
            if (!tag) return res.status(400).json({ error: `unknown tag ${name}` });
            tagIds.push(tag.id);
        }
    }

    const v = validateNewMessage({
        kind: "ticket_created",
        project,
        title: body.title,
        body: body.body,
        priority: body.priority,
        intent: body.intent,
        by_agent: grant.source,
    });
    if ("error" in v) return res.status(400).json({ error: v.error });
    v.by_agent = grant.source;

    const msg = submitMessage(v, { preApprovedByKey: true });
    if (externalId) recordExternalId(msg.id, externalId);
    if (tagIds.length) setMessageTags(msg.id, tagIds, grant.source);
    res.status(201).json({ ...withTagsOne(msg), existing: false });
});
