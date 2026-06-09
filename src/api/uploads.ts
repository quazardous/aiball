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
import { createReadStream, existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createHash } from "node:crypto";
import {
    DEFAULT_UPLOAD_MAX_BYTES,
    UPLOAD_HARD_CAP_BYTES,
    deleteUploadRow,
    getUploadBySha,
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
 * Allowed MIME → file extension (#694). Allow-list, explicit deny by absence.
 * The map drives BOTH the content-type whitelist on upload AND the on-disk
 * filename extension. Categories :
 *   - Images : inline-rendered through marked + DOMPurify (`<img>`). SVG is
 *     intentionally OUT (carries script via `<script>`/`<foreignObject>`).
 *   - Text / source : rendered as code-links `[name.ext](url)` in markdown.
 *     `text/html` is intentionally OUT (would execute its own script when
 *     rendered).
 *   - Application / structured + binaries : download-link references. No
 *     inline render. Executable formats (x-executable, x-mach-binary, PE)
 *     are intentionally OUT.
 */
const UPLOAD_MIME_TO_EXT: Record<string, string> = {
    // Images (inline-render via <img>). `image/svg+xml` deliberately excluded.
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    // Text / source-readable. `text/html` deliberately excluded (XSS).
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/yaml": "yaml",
    "text/x-python": "py",
    "text/x-typescript": "ts",
    "text/javascript": "js",
    "text/x-c": "c",
    "text/x-c++": "cpp",
    "text/x-shellscript": "sh",
    "text/x-diff": "diff",
    "text/x-patch": "patch",
    // Application — structured data + binaries opaques. Executables excluded.
    "application/json": "json",
    "application/x-yaml": "yaml",
    "application/x-toml": "toml",
    "application/x-shellscript": "sh",
    "application/x-patch": "patch",
    "application/x-tar": "tar",
    "application/gzip": "gz",
    "application/zip": "zip",
    "application/pdf": "pdf",
    "application/octet-stream": "bin",
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

/**
 * #841 (apzdv8) — egress for `/uploads/<sha>.<ext>`.
 *
 * Replaces `express.static(UPLOADS_DIR)` so the response carries :
 *   - `Content-Disposition` with the **original filename** the uploader
 *     posted via `x-aiball-upload-name` (preserved server-side since
 *     #B.76 ; previously dropped on download because static didn't read
 *     the metadata).
 *   - inline vs attachment chosen by MIME (image/pdf/text/json → inline,
 *     everything else → attachment), overridable via `?dl=1`.
 *
 * Same caching contract as the prior `express.static` mount (content-
 * addressed → safe `immutable, max-age=86400`).
 */
const INLINE_MIMES = new Set<string>([
    "application/pdf",
    "application/json", // david's call : inline cohérent avec text/*
]);
function pickDisposition(contentType: string, query: unknown): "inline" | "attachment" {
    if ((query as Record<string, unknown>)?.dl === "1") return "attachment";
    if (contentType.startsWith("image/")) return "inline";
    if (contentType.startsWith("text/")) return "inline";
    if (INLINE_MIMES.has(contentType)) return "inline";
    return "attachment";
}

/** Strip path separators + control chars; cap at 200 to mirror the
 *  column width chosen at insert-time. */
function sanitizeFilename(name: string, fallback: string): string {
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/[/\\]/g, "_")
        .trim();
    if (cleaned.length === 0) return fallback;
    return cleaned.slice(0, 200);
}

/** Build a Content-Disposition header that's safe with non-ASCII names
 *  via RFC 5987 `filename*=UTF-8''…`. The legacy `filename="…"` is kept
 *  as a fallback for old clients and uses an ASCII-only sanitized name. */
function buildContentDisposition(kind: "inline" | "attachment", name: string): string {
    const asciiSafe = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "\\\"");
    return `${kind}; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET handler for `/uploads/<sha>.<ext>` — mounted by `createApp()` at the
 * root path (the frontend writes `/uploads/<sha>.<ext>` URLs directly,
 * unprefixed by `/api`). Pure function so it can be tested against an
 * in-process express app without the surrounding daemon.
 */
export function serveUpload(req: Request, res: Response): void {
    const m = /^\/uploads\/([0-9a-f]{64})\.([A-Za-z0-9]+)$/.exec(req.path);
    if (!m) {
        res.status(404).type("text/plain").send("not found");
        return;
    }
    const sha = m[1];
    const ext = m[2];
    const row = getUploadBySha(sha);
    if (!row || row.ext !== ext) {
        res.status(404).type("text/plain").send("not found");
        return;
    }
    const path = joinPath(UPLOADS_DIR, `${sha}.${ext}`);
    if (!existsSync(path)) {
        res.status(404).type("text/plain").send("not found");
        return;
    }
    const stat = statSync(path);
    const disposition = pickDisposition(row.content_type, req.query);
    const fallbackName = `${sha}.${ext}`;
    const displayName = row.original_name
        ? sanitizeFilename(row.original_name, fallbackName)
        : fallbackName;
    res.setHeader("Content-Type", row.content_type);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", buildContentDisposition(disposition, displayName));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    if (req.method === "HEAD") {
        res.end();
        return;
    }
    createReadStream(path).pipe(res);
}

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
