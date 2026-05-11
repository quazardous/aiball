/**
 * Uploads tracking (per #B.76). Storage is content-addressable on
 * disk under `$AIBALL_HOME/uploads/<sha>.<ext>`; rows in this table
 * are pure metadata used by orphan GC and "who uploaded what" queries.
 *
 * Extracted from db.ts (#B.332 Phase A).
 */
import { eq, like, or } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { nowIso } from "./connection.js";

export interface UploadRow {
    sha: string;
    ext: string;
    content_type: string;
    bytes: number;
    by_agent: string | null;
    original_name: string | null;
    created_at: string;
}

export interface UploadInsert {
    sha: string;
    ext: string;
    content_type: string;
    bytes: number;
    by_agent?: string | null;
    original_name?: string | null;
}

/**
 * Idempotent insert — if the row already exists (same content hash),
 * the existing row stays untouched. The caller relies on the file on
 * disk being identical (content-addressable), so the metadata of the
 * first writer is preserved.
 */
export function insertUpload(input: UploadInsert): UploadRow {
    const row = {
        sha: input.sha,
        ext: input.ext,
        contentType: input.content_type,
        bytes: input.bytes,
        byAgent: input.by_agent ?? null,
        originalName: input.original_name ?? null,
        createdAt: nowIso(),
    };
    getDb().insert(schema.uploads).values(row).onConflictDoNothing().run();
    const fresh = getDb().select().from(schema.uploads)
        .where(eq(schema.uploads.sha, input.sha)).get();
    if (!fresh) throw new Error(`upload row vanished after insert: ${input.sha}`);
    return {
        sha: fresh.sha,
        ext: fresh.ext,
        content_type: fresh.contentType,
        bytes: fresh.bytes,
        by_agent: fresh.byAgent,
        original_name: fresh.originalName,
        created_at: fresh.createdAt,
    };
}

export interface UploadStats {
    count: number;
    total_bytes: number;
    orphan_count: number;
    orphan_bytes: number;
}

/**
 * Compute storage stats by joining `uploads` against the union of
 * `tickets.body` + `_messages.body` (with `edited_body` fallback).
 * Orphan = no body anywhere contains the upload URL pattern.
 *
 * The LIKE pattern is `%/uploads/<sha>.%` which is anchored on the
 * URL the frontend writes (`/uploads/<sha>.<ext>`). Good enough for
 * normal usage; tampered bodies (rewritten URLs) would slip through.
 */
export function uploadStats(graceMinutes = 5): UploadStats {
    const db = getDb();
    const all = db.select().from(schema.uploads).all();
    let count = 0, totalBytes = 0, orphanCount = 0, orphanBytes = 0;
    const graceMs = graceMinutes * 60_000;
    const cutoff = Date.now() - graceMs;
    for (const u of all) {
        count += 1;
        totalBytes += u.bytes;
        if (Date.parse(u.createdAt) > cutoff) continue; // still in grace window
        if (!isUploadReferenced(u.sha)) {
            orphanCount += 1;
            orphanBytes += u.bytes;
        }
    }
    return {
        count,
        total_bytes: totalBytes,
        orphan_count: orphanCount,
        orphan_bytes: orphanBytes,
    };
}

function isUploadReferenced(sha: string): boolean {
    const db = getDb();
    const pattern = `%/uploads/${sha}.%`;
    const t = db.select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(
            or(
                like(schema.tickets.body, pattern),
                like(schema.tickets.editedBody, pattern),
            ),
        )
        .limit(1)
        .get();
    if (t) return true;
    const m = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
            or(
                like(schema.messages.body, pattern),
                like(schema.messages.editedBody, pattern),
            ),
        )
        .limit(1)
        .get();
    return !!m;
}

/**
 * Return the rows of uploads not referenced anywhere AND created more
 * than `graceMinutes` ago. The caller deletes the files + rows.
 */
export function listOrphanUploads(graceMinutes = 5): UploadRow[] {
    const db = getDb();
    const cutoff = Date.now() - graceMinutes * 60_000;
    const rows = db.select().from(schema.uploads).all();
    const out: UploadRow[] = [];
    for (const u of rows) {
        if (Date.parse(u.createdAt) > cutoff) continue;
        if (isUploadReferenced(u.sha)) continue;
        out.push({
            sha: u.sha,
            ext: u.ext,
            content_type: u.contentType,
            bytes: u.bytes,
            by_agent: u.byAgent,
            original_name: u.originalName,
            created_at: u.createdAt,
        });
    }
    return out;
}

export function deleteUploadRow(sha: string): void {
    getDb().delete(schema.uploads).where(eq(schema.uploads.sha, sha)).run();
}
