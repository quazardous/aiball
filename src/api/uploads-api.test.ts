/**
 * #3040 — uploads under the API, for clients that are not a browser on this
 * server:
 * - `/api/uploads/<sha>` needs the API's authentication over TCP, and serves
 *   the file (the extension optional; given, it must match);
 * - the hash is the ETag: a repeated request gets a 304;
 * - a text's uploads are listed where the text is returned: a single message,
 *   and each comment of a thread, with their API reference (read over the bus).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3040-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { asToken } = await import("../tests/bus-call.js");
const { insertUpload, upsertConsumer } = await import("../db.js");
const { issueToken } = await import("../db/tokens.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { UPLOADS_DIR } = await import("../paths.js");

mkdirSync(UPLOADS_DIR, { recursive: true });
upsertConsumer({ consumer_id: "boss", kind: "human" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "boss", label: "3040" }).token;
createProject({ name: "p-3040" });

const bytes = Buffer.from("a picture, as far as this test cares");
const sha = createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(UPLOADS_DIR, `${sha}.png`), bytes);
insertUpload({ sha, ext: "png", content_type: "image/png", bytes: bytes.length, original_name: "shot.png" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("the API route needs a token over TCP, then serves the file, with or without its extension", async () => {
    assert.equal((await fetch(`${BASE}/api/uploads/${sha}`)).status, 401, "no token, no file");
    for (const path of [`/api/uploads/${sha}`, `/api/uploads/${sha}.png`]) {
        const r = await fetch(`${BASE}${path}`, { headers: auth });
        assert.equal(r.status, 200, path);
        assert.equal(r.headers.get("content-type"), "image/png");
        assert.match(r.headers.get("cache-control") ?? "", /^private/);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    }
    assert.equal((await fetch(`${BASE}/api/uploads/${sha}.jpg`, { headers: auth })).status, 404, "a wrong extension");
    assert.equal((await fetch(`${BASE}/api/uploads/${"0".repeat(64)}`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${BASE}/api/uploads/stats`, { headers: auth })).status, 200, "the stats route is not shadowed");
});

test("the hash is the ETag: asked again with it, a 304", async () => {
    const first = await fetch(`${BASE}/api/uploads/${sha}`, { headers: auth });
    assert.equal(first.headers.get("etag"), `"${sha}"`);
    const again = await fetch(`${BASE}/api/uploads/${sha}`, { headers: { ...auth, "if-none-match": `"${sha}"` } });
    assert.equal(again.status, 304);
    const web = await fetch(`${BASE}/uploads/${sha}.png`, { headers: { "if-none-match": `"${sha}"` } });
    assert.equal(web.status, 304, "the web path answers the same way");
});

test("a single message and each thread comment list the uploads their text cites", async () => {
    const ref = `/uploads/${sha}.png`;
    const t = submitMessage({ project: "p-3040", kind: "ticket_created", title: "with a picture", body: "see below", by_agent: "boss" }).id;
    const withPic = submitMessage({ project: "p-3040", kind: "comment_added", ticket_id: t, body: `here: ![](${ref})`, by_agent: "boss" }).id;
    const plain = submitMessage({ project: "p-3040", kind: "comment_added", ticket_id: t, body: "no picture", by_agent: "boss" }).id;

    const one = (await asToken<{ attachments: { sha: string; ref: string; api_ref: string }[] }>(TOKEN, "message.get", { id: withPic })).json;
    assert.equal(one.attachments.length, 1);
    assert.equal(one.attachments[0]!.ref, ref);
    assert.equal(one.attachments[0]!.api_ref, `/api/uploads/${sha}`);

    const thread = (await asToken<{ comments: { id: number; attachments?: unknown[] }[] }>(TOKEN, "ticket.get", { id: t, full: true })).json;
    const byId = new Map(thread.comments.map((c) => [c.id, c]));
    assert.equal(byId.get(withPic)?.attachments?.length, 1, "the comment carries its own upload");
    assert.equal(byId.get(plain)?.attachments, undefined, "a comment without one carries no list");
});

/** An upload whose row exists, with `make` shaping what sits at its path. */
function brokenUpload(label: string, make: (path: string) => void): string {
    const b = Buffer.from(`broken ${label}`);
    const s = createHash("sha256").update(b).digest("hex");
    make(join(UPLOADS_DIR, `${s}.png`));
    insertUpload({ sha: s, ext: "png", content_type: "image/png", bytes: b.length, original_name: null });
    return s;
}

async function stillServes(): Promise<void> {
    const r = await fetch(`${BASE}/api/uploads/${sha}`, { headers: auth });
    assert.equal(r.status, 200, "the server still answers the next request");
    await r.arrayBuffer();
}

test("#3185 — a read that fails once streaming (a directory where the file was) ends that response, not the server", async () => {
    const s = brokenUpload("dir", (p) => mkdirSync(p));
    await fetch(`${BASE}/api/uploads/${s}`, { headers: auth }).then((r) => r.arrayBuffer()).catch(() => null);
    await stillServes();
});

test("#3185 — a file gone since its row: 404, and the server goes on", async () => {
    const s = brokenUpload("gone", () => {});
    assert.equal((await fetch(`${BASE}/api/uploads/${s}`, { headers: auth })).status, 404);
    await stillServes();
});

test("#3185 — a file the daemon may not read: 403, and the server goes on", { skip: process.getuid?.() === 0 ? "root reads every file: EACCES cannot happen" : false }, async () => {
    const s = brokenUpload("mode", (p) => { writeFileSync(p, "x"); chmodSync(p, 0o000); });
    const r = await fetch(`${BASE}/api/uploads/${s}`, { headers: auth });
    assert.equal(r.status, 403);
    await stillServes();
});
