/**
 * Tags + ticket_tags. Tags are a closed list maintained by the human
 * moderator; ticket_tags is the many-to-many between tags and tickets
 * (tags are ticket-scoped only, not comment-scoped).
 *
 * Extracted from db.ts (#B.332 Phase A).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
    /** #554 — NULL = global tag (visible across projects) ; a project
     *  name scopes the tag to that project. The catalog defaults from
     *  `config/defaults/tags.yaml` live in the global pool. */
    project: string | null;
}

export interface NewTag {
    name: string;
    color?: string | null;
    note?: string | null;
    position?: number;
    project?: string | null;
}

// The classic catalog (bug/feature/urgent/…) was moved to the shipped
// dist config in #223 cj2kp2 — see `config/defaults/tags.yaml`. The DB
// bootstrap seeds rows from there via `loadShippedDefaultTags()`.

function tagRowToTag(t: schema.Tag): Tag {
    return {
        id: t.id,
        name: t.name,
        color: t.color,
        position: t.position,
        note: t.note,
        created_at: t.createdAt,
        project: t.project,
    };
}

/**
 * #554 — list tags. `project=undefined` (no filter) → all rows. `null`
 *  → global tags only (project IS NULL). A project name → tags scoped
 *  to that project. The catalog endpoint folds global + per-project
 *  via two calls when needed.
 */
export function listTags(project?: string | null): Tag[] {
    const db = getDb();
    let query = db.select().from(schema.tags).$dynamic();
    if (project === null) {
        query = query.where(isNull(schema.tags.project));
    } else if (typeof project === "string") {
        query = query.where(eq(schema.tags.project, project));
    }
    return query.orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all().map(tagRowToTag);
}

export function getTag(id: number): Tag | null {
    const r = getDb().select().from(schema.tags).where(eq(schema.tags.id, id)).get();
    return r ? tagRowToTag(r) : null;
}

/** #554 — name lookup is now project-scoped. `project=undefined` reads
 *  any matching name (back-compat ; first row wins) ; `null` matches the
 *  global tag ; a string matches the project-specific tag. */
export function getTagByName(name: string, project?: string | null): Tag | null {
    const db = getDb();
    if (project === undefined) {
        const r = db.select().from(schema.tags).where(eq(schema.tags.name, name)).get();
        return r ? tagRowToTag(r) : null;
    }
    const conds = project === null
        ? and(eq(schema.tags.name, name), isNull(schema.tags.project))
        : and(eq(schema.tags.name, name), eq(schema.tags.project, project));
    const r = db.select().from(schema.tags).where(conds).get();
    return r ? tagRowToTag(r) : null;
}

export function insertTag(t: NewTag): Tag {
    const r = getDb().insert(schema.tags).values({
        name: t.name,
        color: t.color ?? null,
        position: t.position ?? 0,
        note: t.note ?? null,
        createdAt: nowIso(),
        project: t.project ?? null,
    }).returning().get();
    return tagRowToTag(r);
}

export function updateTag(
    id: number,
    fields: Partial<Pick<Tag, "name" | "color" | "position" | "note">>,
): Tag | null {
    const patch: Partial<schema.NewTagRow> = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.color !== undefined) patch.color = fields.color;
    if (fields.position !== undefined) patch.position = fields.position;
    if (fields.note !== undefined) patch.note = fields.note;
    if (Object.keys(patch).length === 0) return getTag(id);
    getDb().update(schema.tags).set(patch).where(eq(schema.tags.id, id)).run();
    return getTag(id);
}

export function deleteTag(id: number): void {
    getDb().delete(schema.tags).where(eq(schema.tags.id, id)).run();
}

/**
 * Tag operations work on ticket ids only (tags are ticket-scoped).
 * Function names keep the historical `Message` suffix for caller compat.
 */
export function listMessageTags(messageId: number): Tag[] {
    return getDb().select({ t: schema.tags })
        .from(schema.ticketTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.ticketTags.tagId))
        .where(eq(schema.ticketTags.ticketId, messageId))
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all()
        .map((r) => tagRowToTag(r.t));
}

export function tagsForMessages(messageIds: number[]): Map<number, Tag[]> {
    const out = new Map<number, Tag[]>();
    if (!messageIds.length) return out;
    const rows = getDb().select({ t: schema.tags, ticketId: schema.ticketTags.ticketId })
        .from(schema.ticketTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.ticketTags.tagId))
        .where(inArray(schema.ticketTags.ticketId, messageIds))
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all();
    for (const r of rows) {
        if (!out.has(r.ticketId)) out.set(r.ticketId, []);
        out.get(r.ticketId)!.push(tagRowToTag(r.t));
    }
    return out;
}

export function addMessageTag(
    messageId: number,
    tagId: number,
    setBy: string | null = null,
): void {
    getDb().insert(schema.ticketTags).values({
        ticketId: messageId,
        tagId,
        setAt: nowIso(),
        setBy,
    }).onConflictDoNothing().run();
}

export function removeMessageTag(messageId: number, tagId: number): void {
    getDb().delete(schema.ticketTags).where(and(
        eq(schema.ticketTags.ticketId, messageId),
        eq(schema.ticketTags.tagId, tagId),
    )).run();
}

export function setMessageTags(
    messageId: number,
    tagIds: number[],
    setBy: string | null = null,
): void {
    const db = getDb();
    db.transaction((tx) => {
        tx.delete(schema.ticketTags).where(eq(schema.ticketTags.ticketId, messageId)).run();
        const now = nowIso();
        for (const tagId of [...new Set(tagIds)]) {
            tx.insert(schema.ticketTags).values({
                ticketId: messageId,
                tagId,
                setAt: now,
                setBy,
            }).run();
        }
    });
}
