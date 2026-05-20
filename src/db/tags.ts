/**
 * Tags + ticket_tags. Tags are a closed list maintained by the human
 * moderator; ticket_tags is the many-to-many between tags and tickets
 * (tags are ticket-scoped only, not comment-scoped).
 *
 * Extracted from db.ts (#B.332 Phase A).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

export interface NewTag {
    name: string;
    color?: string | null;
    note?: string | null;
    position?: number;
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
    };
}

export function listTags(): Tag[] {
    return getDb().select().from(schema.tags)
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all().map(tagRowToTag);
}

export function getTag(id: number): Tag | null {
    const r = getDb().select().from(schema.tags).where(eq(schema.tags.id, id)).get();
    return r ? tagRowToTag(r) : null;
}

export function getTagByName(name: string): Tag | null {
    const r = getDb().select().from(schema.tags).where(eq(schema.tags.name, name)).get();
    return r ? tagRowToTag(r) : null;
}

export function insertTag(t: NewTag): Tag {
    const r = getDb().insert(schema.tags).values({
        name: t.name,
        color: t.color ?? null,
        position: t.position ?? 0,
        note: t.note ?? null,
        createdAt: nowIso(),
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
