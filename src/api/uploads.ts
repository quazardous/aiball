/**
 * Upload + GC + max-bytes settings routes (per #B.76, carved out of
 * api.ts in #B.213 phase 1.E on 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   POST /uploads                         — store image bytes, returns url/sha
 *   GET  /uploads/stats                   — count + total bytes
 *   POST /uploads/gc                      — collect orphan uploads
 *   GET  /settings/upload-max-bytes       — current cap + defaults
 *   PATCH /settings/upload-max-bytes      — change per-upload cap
 *
 * Storage: `<AIBALL_HOME>/uploads/<sha256>.<ext>`. Hash-addressable so
 * duplicate uploads dedupe naturally.
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createHash } from "node:crypto";
import {
    DEFAULT_UPLOAD_MAX_BYTES,
    UPLOAD_HARD_CAP_BYTES,
    deleteUploadRow,
    getUploadMaxBytes,
    insertUpload,
    listOrphanUploads,
    setUploadMaxBytes,
    uploadStats,
} from "../db.js";
import { UPLOADS_DIR } from "../paths.js";
import { badRequest, consumerOf } from "./_helpers.js";

export const uploadsRouter = Router();

/**
 * Allowed MIME → file extension. Only types we trust to render
 * inline in an <img> through marked + DOMPurify. JPEG covers JPG.
 * SVG is intentionally OUT — it can carry script.
 */
const UPLOAD_MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};

/**
 * POST `/api/uploads` — accepts a raw image body keyed by `Content-Type`,
 * writes it content-addressable under `<AIBALL_HOME>/uploads/<sha256>.<ext>`,
 * returns `{ url, bytes, sha256 }`. The body must be the file bytes
 * directly (no multipart wrapper) — the frontend posts the Blob as the
 * fetch body with the right content-type. Cap is `getUploadMaxBytes()`,
 * defaulting to 10 MB (configurable via `/api/settings/upload-max-bytes`).
 *
 * Hash-addressable storage means duplicate uploads dedupe naturally and
 * the response URL doubles as a stable id for future referencing.
 */
uploadsRouter.post(
    "/uploads",
    // Use raw body parser scoped to this route so the global json parser
    // upstream doesn't try to eat the binary stream. The limit enforces
    // the hard cap; the per-setting limit is checked after parsing.
    express.raw({
        type: () => true,
        limit: UPLOAD_HARD_CAP_BYTES,
    }),
    (req: Request, res: Response) => {
        const ct = (req.header("content-type") ?? "").toLowerCase().split(";")[0].trim();
        const ext = UPLOAD_MIME_TO_EXT[ct];
        if (!ext) {
            return badRequest(
                res,
                `unsupported content-type "${ct}" — allowed: ${Object.keys(UPLOAD_MIME_TO_EXT).join(", ")}`,
            );
        }
        const buf = req.body as Buffer | undefined;
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            return badRequest(res, "empty body");
        }
        const max = getUploadMaxBytes();
        if (buf.length > max) {
            return res.status(413).json({
                error: `upload exceeds limit (${buf.length} > ${max} bytes)`,
                max_bytes: max,
                received_bytes: buf.length,
            });
        }
        const sha = createHash("sha256").update(buf).digest("hex");
        const filename = `${sha}.${ext}`;
        const target = joinPath(UPLOADS_DIR, filename);
        // Hash-addressable — if the file already exists, skip the write.
        // Two callers uploading the same bytes converge on a single file.
        if (!existsSync(target)) {
            writeFileSync(target, buf);
        }
        // Track in the uploads table so GC can find orphans later.
        // Idempotent: re-uploading the same bytes by a different author
        // keeps the first author on record (the first writer wins, no
        // need to mutate metadata).
        insertUpload({
            sha,
            ext,
            content_type: ct,
            bytes: buf.length,
            by_agent: consumerOf(req),
            original_name: typeof req.header("x-aiball-upload-name") === "string"
                ? req.header("x-aiball-upload-name")!.slice(0, 200)
                : null,
        });
        res.status(201).json({
            url: `/uploads/${filename}`,
            sha256: sha,
            bytes: buf.length,
            content_type: ct,
        });
    },
);

uploadsRouter.get("/uploads/stats", (_req, res) => {
    res.json(uploadStats());
});

/**
 * GC pass: find uploads not referenced anywhere in tickets / messages
 * bodies, delete both the on-disk file and the metadata row. A grace
 * window (default 5 min) protects very-recently-uploaded files that
 * the user hasn't yet pasted into a message.
 *
 * `dry_run: true` (or query `?dry_run=1`) only reports what would be
 * removed without touching anything.
 */
uploadsRouter.post("/uploads/gc", (req: Request, res: Response) => {
    const dryRun =
        req.body?.dry_run === true ||
        req.query.dry_run === "1" ||
        req.query.dry_run === "true";
    const graceMinutes = typeof req.body?.grace_minutes === "number"
        ? Math.max(0, req.body.grace_minutes)
        : 5;
    const orphans = listOrphanUploads(graceMinutes);
    let deletedFiles = 0;
    let freedBytes = 0;
    if (!dryRun) {
        for (const u of orphans) {
            const filename = `${u.sha}.${u.ext}`;
            const path = joinPath(UPLOADS_DIR, filename);
            try {
                if (existsSync(path)) {
                    unlinkSync(path);
                    deletedFiles += 1;
                    freedBytes += u.bytes;
                }
                deleteUploadRow(u.sha);
            } catch (e) {
                // Best-effort: log + keep going. A stale row left behind
                // is harmless; we'll retry next GC.
                console.error(`[uploads/gc] failed for ${filename}:`, e);
            }
        }
    }
    res.json({
        dry_run: dryRun,
        grace_minutes: graceMinutes,
        candidates: orphans.length,
        candidate_bytes: orphans.reduce((s, u) => s + u.bytes, 0),
        deleted_files: deletedFiles,
        freed_bytes: freedBytes,
        orphans: orphans.map((u) => ({
            sha: u.sha,
            ext: u.ext,
            bytes: u.bytes,
            by_agent: u.by_agent,
            created_at: u.created_at,
        })),
    });
});

uploadsRouter.get("/settings/upload-max-bytes", (_req, res) => {
    res.json({
        bytes: getUploadMaxBytes(),
        default: DEFAULT_UPLOAD_MAX_BYTES,
        hard_cap: UPLOAD_HARD_CAP_BYTES,
    });
});

uploadsRouter.patch("/settings/upload-max-bytes", (req: Request, res: Response) => {
    const { bytes } = (req.body ?? {}) as { bytes?: unknown };
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
        return badRequest(res, "bytes must be a positive number");
    }
    setUploadMaxBytes(bytes);
    res.json({
        bytes: getUploadMaxBytes(),
        default: DEFAULT_UPLOAD_MAX_BYTES,
        hard_cap: UPLOAD_HARD_CAP_BYTES,
    });
});
