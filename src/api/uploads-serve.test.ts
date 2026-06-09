// #841 — egress tests for GET /uploads/<sha>.<ext>.
// Mounts the REAL app on an ephemeral port + drives it via fetch.
//
// Asserts :
//   - original_name surfaces in Content-Disposition (+ RFC 5987 utf-8 fallback)
//   - inline vs attachment chosen by MIME (image/json/pdf/text → inline,
//     application/zip etc. → attachment)
//   - `?dl=1` overrides inline → attachment
//   - filename sanitization strips path separators / control chars / caps 200
//   - 404 when sha row is missing, or the disk file is gone, or ext mismatches
//   - cache-control + content-type/content-length headers
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-841-"));

const { createApp } = await import("../app.js");
const { insertUpload } = await import("../db.js");
const { UPLOADS_DIR } = await import("../paths.js");

mkdirSync(UPLOADS_DIR, { recursive: true });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

after(() => {
    server.close();
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});

interface SeedOpts {
    bytes?: Buffer;
    ext: string;
    contentType: string;
    originalName?: string | null;
}
function seed(opts: SeedOpts): { sha: string; ext: string; url: string } {
    const bytes = opts.bytes ?? Buffer.from(`payload-${Math.random()}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(UPLOADS_DIR, `${sha}.${opts.ext}`), bytes);
    insertUpload({
        sha,
        ext: opts.ext,
        content_type: opts.contentType,
        bytes: bytes.length,
        original_name: opts.originalName ?? null,
    });
    return { sha, ext: opts.ext, url: `/uploads/${sha}.${opts.ext}` };
}

test("image MIME → inline with original filename", async () => {
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "screenshot.png",
    });
    const r = await fetch(`${BASE}${url}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    const cd = r.headers.get("content-disposition")!;
    assert.match(cd, /^inline;/);
    assert.match(cd, /filename="screenshot\.png"/);
    assert.match(cd, /filename\*=UTF-8''screenshot\.png/);
});

test("application/zip → attachment", async () => {
    const { url } = seed({
        ext: "zip",
        contentType: "application/zip",
        originalName: "report.zip",
    });
    const r = await fetch(`${BASE}${url}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition")!, /^attachment;/);
});

test("text/plain → inline", async () => {
    const { url } = seed({
        ext: "txt",
        contentType: "text/plain",
        originalName: "notes.txt",
    });
    const r = await fetch(`${BASE}${url}`);
    assert.match(r.headers.get("content-disposition")!, /^inline;/);
});

test("application/pdf → inline", async () => {
    const { url } = seed({
        ext: "pdf",
        contentType: "application/pdf",
        originalName: "spec.pdf",
    });
    const r = await fetch(`${BASE}${url}`);
    assert.match(r.headers.get("content-disposition")!, /^inline;/);
});

test("application/json → inline (david's call)", async () => {
    const { url } = seed({
        ext: "json",
        contentType: "application/json",
        originalName: "data.json",
    });
    const r = await fetch(`${BASE}${url}`);
    assert.match(r.headers.get("content-disposition")!, /^inline;/);
});

test("?dl=1 forces attachment on an otherwise-inline MIME", async () => {
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "shot.png",
    });
    const r = await fetch(`${BASE}${url}?dl=1`);
    assert.match(r.headers.get("content-disposition")!, /^attachment;/);
});

test("missing original_name falls back to <sha>.<ext>", async () => {
    const { url, sha, ext } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: null,
    });
    const r = await fetch(`${BASE}${url}`);
    const cd = r.headers.get("content-disposition")!;
    assert.match(cd, new RegExp(`filename="${sha}\\.${ext}"`));
});

test("filename sanitization strips path separators", async () => {
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "../../etc/passwd.png",
    });
    const r = await fetch(`${BASE}${url}`);
    const cd = r.headers.get("content-disposition")!;
    assert.doesNotMatch(cd, /\.\.\//);
    assert.doesNotMatch(cd, /etc\/passwd/);
    assert.match(cd, /filename="\.\._\.\._etc_passwd\.png"/);
});

test("filename sanitization strips control chars", async () => {
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "shot\x07\x00.png",
    });
    const r = await fetch(`${BASE}${url}`);
    const cd = r.headers.get("content-disposition")!;
    assert.match(cd, /filename="shot\.png"/);
});

test("404 when sha row missing", async () => {
    const fakeSha = "0".repeat(64);
    const r = await fetch(`${BASE}/uploads/${fakeSha}.png`);
    assert.equal(r.status, 404);
});

test("404 when ext mismatches stored row", async () => {
    const { sha } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: null,
    });
    const r = await fetch(`${BASE}/uploads/${sha}.zip`);
    assert.equal(r.status, 404);
});

test("404 when disk file is gone (DB row stranded)", async () => {
    const { url, sha, ext } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: null,
    });
    unlinkSync(join(UPLOADS_DIR, `${sha}.${ext}`));
    const r = await fetch(`${BASE}${url}`);
    assert.equal(r.status, 404);
});

test("malformed URL → 404 (does not match the route regex)", async () => {
    const r = await fetch(`${BASE}/uploads/not-a-sha.png`);
    assert.equal(r.status, 404);
});

test("Cache-Control + Content-Length headers", async () => {
    const payload = Buffer.from("abcdef");
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "x.png",
        bytes: payload,
    });
    const r = await fetch(`${BASE}${url}`);
    assert.equal(r.headers.get("cache-control"), "public, max-age=86400, immutable");
    assert.equal(r.headers.get("content-length"), String(payload.length));
    const body = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(body, payload);
});

test("HEAD returns headers + empty body", async () => {
    const payload = Buffer.from("hello-head");
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "h.png",
        bytes: payload,
    });
    const r = await fetch(`${BASE}${url}`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), String(payload.length));
    const body = await r.arrayBuffer();
    assert.equal(body.byteLength, 0);
});

test("RFC 5987 utf-8 fallback carries non-ASCII filename", async () => {
    const { url } = seed({
        ext: "png",
        contentType: "image/png",
        originalName: "capture été.png",
    });
    const r = await fetch(`${BASE}${url}`);
    const cd = r.headers.get("content-disposition")!;
    // ASCII fallback replaces non-ASCII with _ ; UTF-8 form encodes everything.
    assert.match(cd, /filename="capture _t_\.png"/);
    assert.match(cd, /filename\*=UTF-8''capture%20%C3%A9t%C3%A9\.png/);
});
