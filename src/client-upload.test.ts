/**
 * #3252 — uploads and downloads go through the client's one transport: the
 * identity headers every request carries, the retry of a daemon being
 * restarted, and a refusal typed like every other (status + code), so a 4xx
 * reads apart from a transport failure. Over a real Unix socket.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiballClient } from "./client.js";
import { ApiError, apiErrorOf } from "./api-error.js";

const DIR = mkdtempSync(join(tmpdir(), "aiball-3252-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A daemon's /api/uploads and /uploads that answers `status`, after dropping the first `dropFirst` connections. */
async function uploads(name: string, status: number, dropFirst = 0): Promise<{ sock: string; server: Server; seen: IncomingMessage[] }> {
    const sock = join(DIR, `${name}.sock`);
    const seen: IncomingMessage[] = [];
    const server = createServer((req, res) => {
        seen.push(req);
        req.resume();
        req.on("end", () => {
            if (status !== 200) {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "the file is over the limit", code: "PAYLOAD_TOO_LARGE", details: { max: 10 } }));
                return;
            }
            if (req.method === "GET") {
                res.writeHead(200, { "content-type": "image/png" });
                res.end(Buffer.from([1, 2, 3]));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ url: "/uploads/abc.png", sha256: "abc", bytes: 3, content_type: "image/png" }));
        });
    });
    let connections = 0;
    server.on("connection", (s) => { if (connections++ < dropFirst) s.destroy(); });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    return { sock, server, seen };
}

test("an upload carries the identity headers every request carries", async () => {
    const { sock, server, seen } = await uploads("ok", 200);
    try {
        const r = await new AiballClient({ socketPath: sock, agentId: "me", features: ["commits"] }).uploadFile(Buffer.from([1, 2, 3]), "image/png", "shot.png");
        assert.equal(r.sha256, "abc");
        const h = seen[0]!.headers;
        assert.equal(h["x-aiball-consumer"], "me");
        assert.equal(h["x-aiball-platform"], process.platform);
        assert.equal(h["x-aiball-client"], "commits");
        assert.equal(h["x-aiball-upload-name"], "shot.png");
        assert.equal(h["content-type"], "image/png");
    } finally {
        server.close();
    }
});

test("a refused upload is an ApiError with its status and code; a download too", async () => {
    const { sock, server } = await uploads("refused", 413);
    try {
        const c = new AiballClient({ socketPath: sock, agentId: "me" });
        const refused = await c.uploadFile(Buffer.from([1]), "image/png").then(() => null, (e: unknown) => e);
        assert.ok(refused instanceof ApiError, "typed");
        assert.equal(refused.status, 413);
        assert.equal(refused.code, "PAYLOAD_TOO_LARGE");
        assert.deepEqual(refused.details, { max: 10 });
        const missing = await c.downloadUpload("abc.png").then(() => null, (e: unknown) => e);
        assert.ok(missing instanceof ApiError);
        assert.equal(missing.status, 413);
    } finally {
        server.close();
    }
});

test("a daemon being restarted is waited for: the upload is retried and lands once", async () => {
    const { sock, server, seen } = await uploads("flaky", 200, 2);
    try {
        const c = new AiballClient({ socketPath: sock, agentId: "me" });
        const r = await c.uploadFile(Buffer.from([1, 2, 3]), "image/png");
        assert.equal(r.url, "/uploads/abc.png");
        assert.equal(seen.length, 1, "handled once");
        const d = await c.downloadUpload("abc.png");
        assert.deepEqual([...d.bytes], [1, 2, 3]);
        assert.equal(d.contentType, "image/png");
    } finally {
        server.close();
    }
});

test("no daemon at all: a transport error, no status, naming the request and the socket", async () => {
    const sock = join(DIR, "nobody.sock");
    const e = await new AiballClient({ socketPath: sock, agentId: "me" }).uploadFile(Buffer.from([1]), "image/png").then(() => null, (x: unknown) => x as Error & { code?: string; status?: number });
    assert.ok(e && !(e instanceof ApiError), "not a refusal");
    assert.equal(e.status, undefined);
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /POST \/api\/uploads via unix:.*nobody\.sock/);
});

test("a body that is not a refusal keeps its text and takes the status's generic code", () => {
    const e = apiErrorOf(502, "<html>Bad Gateway</html>", "GET /api/x");
    assert.equal(e.code, "BAD_GATEWAY");
    assert.equal(e.status, 502);
    assert.match(e.message, /GET \/api\/x → 502: <html>Bad Gateway/);
});
