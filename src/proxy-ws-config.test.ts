// #775 — integration test for the `node_project_config_push` frame.
// Spawns the real WS server, opens a node connection with a valid
// token, pushes a config payload, and asserts both the store and the
// derived `consumers.can_claim` row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-775-ws-"));
process.env.AIBALL_HOME = home;

const { createApp } = await import("./app.js");
const { attachProxyWs, PROXY_WS_PATH } = await import("./proxy-ws.js");
const { issueToken } = await import("./db/tokens.js");
const { getConsumer } = await import("./db/consumers.js");
const { getNodeProjectConfig } = await import("./db/node-project-config.js");

const NODE_TOKEN = issueToken({ kind: "node", label: "775-ws-test" }).token;
const server = createServer(createApp());
attachProxyWs(server);
server.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const WS_URL = `ws://127.0.0.1:${port}${PROXY_WS_PATH}`;

after(() => {
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function openNodeWs(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${token}` } });
        const t = setTimeout(() => reject(new Error("open timeout")), 2000);
        ws.on("open", () => { clearTimeout(t); resolve(ws); });
        ws.on("unexpected-response", (_req, res) => { clearTimeout(t); reject(new Error(`status ${res.statusCode}`)); });
        ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

test("#775: push frame upserts the row + derives consumers.can_claim", async () => {
    const ws = await openNodeWs(NODE_TOKEN);
    ws.send(JSON.stringify({
        kind: "node_project_config_push",
        project: "p-775",
        consumers: [{ agent: "agent-775", no_claim: true }],
    }));
    // The handler is sync but the message walks through the WS layer ;
    // give it a tick.
    await sleep(80);
    ws.close();
    const row = getNodeProjectConfig(NODE_TOKEN, "p-775");
    assert.ok(row, "config row stored");
    assert.equal(row.config.consumers[0]?.agent, "agent-775");
    assert.equal(row.config.consumers[0]?.no_claim, true);
    const c = getConsumer("agent-775");
    assert.ok(c, "consumer pre-declared by handler");
    assert.equal(c.can_claim, false, "can_claim derived from no_claim=true");
});

test("#775: flipping no_claim to false flips can_claim back to true", async () => {
    const ws = await openNodeWs(NODE_TOKEN);
    ws.send(JSON.stringify({
        kind: "node_project_config_push",
        project: "p-775",
        consumers: [{ agent: "agent-775", no_claim: false }],
    }));
    await sleep(80);
    ws.close();
    const c = getConsumer("agent-775");
    assert.equal(c?.can_claim, true);
});

test("#775: a frame missing `project` is dropped, no row touched", async () => {
    const ws = await openNodeWs(NODE_TOKEN);
    ws.send(JSON.stringify({
        kind: "node_project_config_push",
        consumers: [{ agent: "agent-noop", no_claim: true }],
    }));
    await sleep(80);
    ws.close();
    assert.equal(getConsumer("agent-noop"), null, "consumer not pre-declared on invalid frame");
});

test("#775: omitting `no_claim` on a consumer entry leaves can_claim untouched", async () => {
    const ws = await openNodeWs(NODE_TOKEN);
    ws.send(JSON.stringify({
        kind: "node_project_config_push",
        project: "p-775",
        consumers: [{ agent: "agent-775" }],
    }));
    await sleep(80);
    ws.close();
    // Previous test left agent-775 with can_claim=true. Should stay.
    const c = getConsumer("agent-775");
    assert.equal(c?.can_claim, true);
});
