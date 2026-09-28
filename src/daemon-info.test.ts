// #3260 — the web UI's addresses daemon.info answers: the local one from the listen address, the public one only from a declared tailscale serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicUrl, webUrl } from "./daemon-info.js";

test("web_url: the listen address; a wildcard bind is reached on loopback", () => {
    assert.equal(webUrl("127.0.0.1", 7777), "http://127.0.0.1:7777/");
    assert.equal(webUrl("0.0.0.0", 7797), "http://127.0.0.1:7797/");
    assert.equal(webUrl("100.64.0.3", 7777), "http://100.64.0.3:7777/");
    assert.equal(webUrl("::1", 7777), "http://[::1]:7777/");
    assert.equal(webUrl("127.0.0.1", NaN), null);
});

test("public_url: the declared serve on the tailnet name, its port only when not the default, its path", () => {
    const ts = { enabled: true, autostart: true, mode: "https" as const };
    assert.equal(publicUrl({ ...ts, port: 8443, path: "/aiball" }, "graphite.tail-x.ts.net."), "https://graphite.tail-x.ts.net:8443/aiball/");
    assert.equal(publicUrl(ts, "graphite.tail-x.ts.net."), "https://graphite.tail-x.ts.net/");
    assert.equal(publicUrl({ ...ts, mode: "http" }, "g.ts.net"), "http://g.ts.net/");
    assert.equal(publicUrl({ ...ts, mode: "http", port: 8080 }, "g.ts.net"), "http://g.ts.net:8080/");
});

test("public_url: none without a declared, enabled serve, or without the tailnet name", () => {
    assert.equal(publicUrl(undefined, "g.ts.net"), null);
    assert.equal(publicUrl({ enabled: false, autostart: true, mode: "https" }, "g.ts.net"), null);
    assert.equal(publicUrl({ enabled: true, autostart: true, mode: "https" }, null), null);
});
