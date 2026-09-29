/**
 * #1179 — the daemon served under a path by a proxy that forwards it: the
 * prefix is removed before the routes and the bus see the url, and a url
 * without it (a proxy that strips it) is left alone.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

const home = mkdtempSync(join(tmpdir(), "aiball-1179-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "config");

const { stripBasePath, resolveBasePath } = await import("./base-path.js");
const { createApp } = await import("./app.js");
const { attachBus } = await import("./bus/server.js");
const { issueToken } = await import("./db/tokens.js");
const { upsertConsumer } = await import("./db.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "boss", label: "1179" }).token;

const server = createServer(createApp({ basePath: "/aiball" }));
const wss = attachBus(server, { basePath: "/aiball" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const PORT = (server.address() as AddressInfo).port;
after(() => {
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections();
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold the db */ }
});

function writeGlobalConfig(yaml: string) {
    mkdirSync(join(home, "config", "aiball"), { recursive: true });
    writeFileSync(join(home, "config", "aiball", "config.yaml"), yaml);
}

test("the prefix is removed from a url under it, and only from one", () => {
    assert.equal(stripBasePath("/aiball/api/x", "/aiball"), "/api/x");
    assert.equal(stripBasePath("/aiball", "/aiball"), "/");
    assert.equal(stripBasePath("/aiball/", "/aiball"), "/");
    assert.equal(stripBasePath("/aiball?token=t", "/aiball"), "/?token=t");
    assert.equal(stripBasePath("/api/x", "/aiball"), "/api/x", "a proxy that strips it already");
    assert.equal(stripBasePath("/aiballx/api", "/aiball"), "/aiballx/api", "another path sharing the prefix");
    assert.equal(stripBasePath("/api/x", undefined), "/api/x");
});

test("the prefix comes from server.base_path, else the tailscale provider's path, else none", () => {
    writeGlobalConfig("");
    assert.equal(resolveBasePath(), undefined);
    writeGlobalConfig("providers:\n  tailscale:\n    path: /ts/\n");
    assert.equal(resolveBasePath(), "/ts");
    writeGlobalConfig("server:\n  base_path: aiball\nproviders:\n  tailscale:\n    path: /ts\n");
    assert.equal(resolveBasePath(), "/aiball");
    writeGlobalConfig("server:\n  base_path: /\n");
    assert.equal(resolveBasePath(), undefined, "the root is no prefix");
});

test("the API answers under the prefix and without it", async () => {
    for (const path of ["/aiball/api/node", "/api/node"]) {
        const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
        assert.equal(r.status, 200, path);
        assert.match(r.headers.get("content-type") ?? "", /json/, path);
        assert.equal(((await r.json()) as { ok: boolean }).ok, true, path);
    }
});

test("the bus accepts a connection under the prefix", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/aiball/bus?token=${TOKEN}`);
    try {
        await new Promise<void>((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
            ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        });
    } finally {
        ws.terminate();
    }
});
