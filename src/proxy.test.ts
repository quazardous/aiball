import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { proxyMiddleware, proxyLandingHtml, type ProxyTokenStore } from "./proxy.js";

// Starts a server on an ephemeral port ; returns the port.
function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
    });
}

// #394 QW-A : the proxy must overwrite the Authorization with the node token ONLY
// if the caller does not already carry one. A caller with its own agent
// token (per-consumer proof) goes through the proxy as is ; a token-less
// caller falls back to the node token (X-Forwarded-For model).
test("#394 QW-A: proxy preserves a caller's own bearer, node token only as fallback", async () => {
    let received: string | undefined;
    const upstream = http.createServer((req, res) => {
        received = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upPort = await listen(upstream);

    const app = express();
    app.use(proxyMiddleware({ url: `http://127.0.0.1:${upPort}`, token: "node-tok" }));
    const proxySrv = http.createServer(app);
    const pxPort = await listen(proxySrv);

    const call = (headers: Record<string, string>): Promise<void> =>
        new Promise((resolve, reject) => {
            const r = http.request(
                { host: "127.0.0.1", port: pxPort, path: "/api/health", method: "GET", headers },
                (res) => {
                    res.resume();
                    res.on("end", () => resolve());
                },
            );
            r.on("error", reject);
            r.end();
        });

    // (1) token-less caller → node token injected (fallback).
    received = undefined;
    await call({});
    assert.equal(received, "Bearer node-tok");

    // (2) caller with its own agent token → kept (NOT overwritten).
    received = undefined;
    await call({ authorization: "Bearer agent-xyz" });
    assert.equal(received, "Bearer agent-xyz");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 "kill the weak point" : in strict mode the proxy NEVER injects the
// node token. A token-less request is rejected (401) BEFORE any forward ;
// a request carrying its own bearer passes as is (per-consumer proof).
test("#394 strict: token-less call is 401'd, own bearer passes, node token never injected", async () => {
    let received: string | undefined;
    let reached = false;
    const upstream = http.createServer((req, res) => {
        reached = true;
        received = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upPort = await listen(upstream);

    const app = express();
    app.use(proxyMiddleware({ url: `http://127.0.0.1:${upPort}`, token: "node-tok", strict: true }));
    const proxySrv = http.createServer(app);
    const pxPort = await listen(proxySrv);

    const call = (headers: Record<string, string>): Promise<number> =>
        new Promise((resolve, reject) => {
            const r = http.request(
                { host: "127.0.0.1", port: pxPort, path: "/api/health", method: "GET", headers },
                (res) => {
                    res.resume();
                    res.on("end", () => resolve(res.statusCode ?? 0));
                },
            );
            r.on("error", reject);
            r.end();
        });

    // (1) token-less caller → local 401, never forwarded, node token NOT injected.
    received = undefined;
    reached = false;
    const status1 = await call({});
    assert.equal(status1, 401);
    assert.equal(reached, false, "strict mode must not forward a token-less request");

    // (2) caller with its own agent token → forwarded as is (per-consumer proof).
    received = undefined;
    reached = false;
    const status2 = await call({ authorization: "Bearer agent-xyz" });
    assert.equal(status2, 200);
    assert.equal(received, "Bearer agent-xyz");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 node-managed store : a known LOCAL bearer is swapped for the A-token
// mapped at egress ; an unknown bearer (the client's own A-token) passes as
// is. Combined with strict : a local token becomes a valid proof.
test("#394 node store: a local bearer is swapped for the mapped upstream A-token", async () => {
    let received: string | undefined;
    const upstream = http.createServer((req, res) => {
        received = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upPort = await listen(upstream);

    const store: ProxyTokenStore = new Map([
        ["aiball-local-alice", { remote: "aiball-A-alice", consumer: "alice" }],
    ]);
    const app = express();
    app.use(
        proxyMiddleware(
            { url: `http://127.0.0.1:${upPort}`, token: "node-tok", strict: true },
            store,
        ),
    );
    const proxySrv = http.createServer(app);
    const pxPort = await listen(proxySrv);

    const call = (headers: Record<string, string>): Promise<number> =>
        new Promise((resolve, reject) => {
            const r = http.request(
                { host: "127.0.0.1", port: pxPort, path: "/api/health", method: "GET", headers },
                (res) => {
                    res.resume();
                    res.on("end", () => resolve(res.statusCode ?? 0));
                },
            );
            r.on("error", reject);
            r.end();
        });

    // (1) known LOCAL bearer → swapped for the mapped A-token (per-consumer proof).
    received = undefined;
    const s1 = await call({ authorization: "Bearer aiball-local-alice" });
    assert.equal(s1, 200);
    assert.equal(received, "Bearer aiball-A-alice");

    // (2) unknown bearer (the client already carries its own A-token) → passes as is.
    received = undefined;
    const s2 = await call({ authorization: "Bearer aiball-A-bob-own" });
    assert.equal(s2, 200);
    assert.equal(received, "Bearer aiball-A-bob-own");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #463 — the proxy advertises its node label on every forwarded request via
// `x-aiball-node-label` so the upstream daemon can sync `tokens.label` and
// pick up a rename on the next request without re-minting.
test("#463: proxy injects x-aiball-node-label when configured", async () => {
    let receivedLabel: string | undefined;
    const upstream = http.createServer((req, res) => {
        const h = req.headers["x-aiball-node-label"];
        receivedLabel = typeof h === "string" ? h : undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upPort = await listen(upstream);

    const app = express();
    app.use(proxyMiddleware({
        url: `http://127.0.0.1:${upPort}`,
        token: "node-tok",
        nodeLabel: "my-laptop",
    }));
    const proxySrv = http.createServer(app);
    const pxPort = await listen(proxySrv);

    await new Promise<void>((resolve, reject) => {
        const r = http.request(
            { host: "127.0.0.1", port: pxPort, path: "/api/health", method: "GET" },
            (res) => { res.resume(); res.on("end", () => resolve()); },
        );
        r.on("error", reject);
        r.end();
    });
    assert.equal(receivedLabel, "my-laptop");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #463 — when no nodeLabel is configured the header is NOT injected (defensive
// : loadProxy() always defaults to hostname(), so in practice this only
// happens when proxyMiddleware is invoked directly with a partial config).
test("#463: proxy does NOT inject x-aiball-node-label when unset", async () => {
    let receivedLabel: string | undefined;
    const upstream = http.createServer((req, res) => {
        const h = req.headers["x-aiball-node-label"];
        receivedLabel = typeof h === "string" ? h : undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upPort = await listen(upstream);

    const app = express();
    app.use(proxyMiddleware({ url: `http://127.0.0.1:${upPort}`, token: "node-tok" }));
    const proxySrv = http.createServer(app);
    const pxPort = await listen(proxySrv);

    await new Promise<void>((resolve, reject) => {
        const r = http.request(
            { host: "127.0.0.1", port: pxPort, path: "/api/health", method: "GET" },
            (res) => { res.resume(); res.on("end", () => resolve()); },
        );
        r.on("error", reject);
        r.end();
    });
    assert.equal(receivedLabel, undefined);

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 (8c7xut): the proxy page announces the remote and escapes the URL.
test("#394: proxyLandingHtml announces the remote URL and escapes it", () => {
    const html = proxyLandingHtml("https://a-host:7777");
    assert.match(html, /proxy mode/i);
    assert.match(html, /https:\/\/a-host:7777/);
    assert.match(html, /Open the remote aiball/);

    // URL with HTML metacharacters must be escaped (no raw injection).
    const evil = proxyLandingHtml('https://x/"><script>alert(1)</script>');
    assert.ok(!evil.includes("<script>"), "must escape angle brackets in the URL");
    assert.match(evil, /&lt;script&gt;/);
});
