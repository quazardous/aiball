import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { proxyMiddleware, proxyLandingHtml, type ProxyTokenStore } from "./proxy.js";

// Démarre un serveur sur un port éphémère ; renvoie le port.
function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
    });
}

// #394 QW-A : le proxy ne doit écraser l'Authorization par le token node QUE
// si l'appelant n'en porte pas déjà un. Un appelant avec son propre token
// agent (preuve per-consumer) traverse le proxy tel quel ; un appelant
// token-less retombe sur le token node (modèle X-Forwarded-For).
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

    // (1) appelant token-less → token node injecté (fallback).
    received = undefined;
    await call({});
    assert.equal(received, "Bearer node-tok");

    // (2) appelant avec son propre token agent → préservé (PAS écrasé).
    received = undefined;
    await call({ authorization: "Bearer agent-xyz" });
    assert.equal(received, "Bearer agent-xyz");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 « tuer le point faible » : en mode strict le proxy n'injecte JAMAIS le
// token node. Une requête token-less est rejetée (401) AVANT tout forward ;
// une requête qui porte son propre bearer passe tel quel (preuve per-consumer).
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

    // (1) appelant token-less → 401 local, jamais forwardé, token node PAS injecté.
    received = undefined;
    reached = false;
    const status1 = await call({});
    assert.equal(status1, 401);
    assert.equal(reached, false, "strict mode must not forward a token-less request");

    // (2) appelant avec son propre token agent → forwardé tel quel (preuve per-consumer).
    received = undefined;
    reached = false;
    const status2 = await call({ authorization: "Bearer agent-xyz" });
    assert.equal(status2, 200);
    assert.equal(received, "Bearer agent-xyz");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 node-managed store : un bearer LOCAL connu est swappé contre le token A
// mappé à l'egress ; un bearer inconnu (token A propre du client) passe tel
// quel. Combiné avec strict : un token local devient une preuve valide.
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

    // (1) bearer LOCAL connu → swappé contre le token A mappé (preuve per-consumer).
    received = undefined;
    const s1 = await call({ authorization: "Bearer aiball-local-alice" });
    assert.equal(s1, 200);
    assert.equal(received, "Bearer aiball-A-alice");

    // (2) bearer inconnu (le client porte déjà son propre token A) → passe tel quel.
    received = undefined;
    const s2 = await call({ authorization: "Bearer aiball-A-bob-own" });
    assert.equal(s2, 200);
    assert.equal(received, "Bearer aiball-A-bob-own");

    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxySrv.close(r));
});

// #394 (8c7xut): la page proxy annonce le remote et échappe l'URL.
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
