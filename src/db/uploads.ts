/**
 * Uploads tracking (per #B.76). Storage is content-addressable on
 * disk under `$AIBALL_HOME/uploads/<sha>.<ext>`; rows in this table
 * are pure metadata used by orphan GC and "who uploaded what" queries.
 *
 * Extracted from db.ts (#B.332 Phase A).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq, inArray, like, or } from "drizzle-orm";
import * as schema from "../schema.js";
import { UPLOADS_DIR } from "../paths.js";
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

/** Single-row metadata lookup by content hash. Returns null when no row
 *  exists (= /uploads/<sha>.<ext> is a 404). Used by the egress handler
 *  (#841) to derive `original_name` + `content_type` for headers. */
export function getUploadBySha(sha: string): UploadRow | null {
    const r = getDb().select().from(schema.uploads)
        .where(eq(schema.uploads.sha, sha)).get();
    if (!r) return null;
    return {
        sha: r.sha,
        ext: r.ext,
        content_type: r.contentType,
        bytes: r.bytes,
        by_agent: r.byAgent,
        original_name: r.originalName,
        created_at: r.createdAt,
    };
}

/** Batch metadata lookup by content hash. Used to enrich the attachments
 *  surfaced on a ticket read (#283). Missing shas are simply absent from
 *  the map — the caller still emits the attachment from the URL alone. */
export function getUploadsByShas(shas: string[]): Map<string, UploadRow> {
    const out = new Map<string, UploadRow>();
    if (shas.length === 0) return out;
    const rows = getDb().select().from(schema.uploads)
        .where(inArray(schema.uploads.sha, shas))
        .all();
    for (const r of rows) {
        out.set(r.sha, {
            sha: r.sha,
            ext: r.ext,
            content_type: r.contentType,
            bytes: r.bytes,
            by_agent: r.byAgent,
            original_name: r.originalName,
            created_at: r.createdAt,
        });
    }
    return out;
}

/**
 * A `/uploads/<sha>.<ext>` reference resolved to something an agent can
 * actually open (#283). David: a cold-start agent wasted ~90s reverse-
 * engineering where an uploaded screenshot lived on disk — the body only
 * carries the daemon HTTP path, not the filesystem path.
 *
 * `local` tells the consumer how to read `uri`:
 *   - `local: true`  → `uri` is a `file://` path on THIS host; read it
 *     directly (the agent's `Read` tool). Emitted only for same-host
 *     callers (UDS / local-trust) AND when the file is actually on disk.
 *   - `local: false` → `uri` is the HTTP `ref`; fetch it over the wire.
 *     (Remote daemon, or file missing locally.)
 * david #84u7kg: "il faut un moyen de dire uri est local dans la reponse"
 * — hence the explicit flag rather than guessing from the string.
 */
export interface ResolvedAttachment {
    sha: string;
    ext: string;
    content_type: string | null;
    bytes: number | null;
    /** The literal `/uploads/<sha>.<ext>` reference as it appears in the body. */
    ref: string;
    /** `file://<abs>` when `local`, else the HTTP `ref`. */
    uri: string;
    /** True ⇒ `uri` is a local filesystem path readable directly. */
    local: boolean;
}

const UPLOAD_REF_RE = /\/uploads\/([a-f0-9]{64})\.([a-zA-Z0-9]{1,8})/g;

/**
 * Scan a set of message bodies for `/uploads/<sha>.<ext>` references and
 * return one resolved attachment per distinct upload (#283). `localTrust`
 * is the caller's transport verdict (true for UDS / same-host): when true
 * and the file exists on disk, the attachment carries a `file://` `uri` the
 * agent can `Read` directly; otherwise it falls back to the HTTP `ref`.
 */
export function resolveAttachments(
    bodies: (string | null | undefined)[],
    localTrust: boolean,
): ResolvedAttachment[] {
    const found = new Map<string, string>(); // sha → ext (first seen)
    for (const body of bodies) {
        if (!body) continue;
        UPLOAD_REF_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = UPLOAD_REF_RE.exec(body)) !== null) {
            if (!found.has(m[1])) found.set(m[1], m[2]);
        }
    }
    if (found.size === 0) return [];
    const metas = getUploadsByShas([...found.keys()]);
    const out: ResolvedAttachment[] = [];
    for (const [sha, refExt] of found) {
        const meta = metas.get(sha);
        const ext = meta?.ext ?? refExt;
        const ref = `/uploads/${sha}.${ext}`;
        const abs = join(UPLOADS_DIR, `${sha}.${ext}`);
        const local = localTrust && existsSync(abs);
        out.push({
            sha,
            ext,
            content_type: meta?.content_type ?? null,
            bytes: meta?.bytes ?? null,
            ref,
            uri: local ? pathToFileURL(abs).href : ref,
            local,
        });
    }
    return out;
}
