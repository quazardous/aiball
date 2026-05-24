import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { proxyMiddleware, proxyLandingHtml } from "./proxy.js";

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
