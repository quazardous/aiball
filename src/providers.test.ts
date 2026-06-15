// #986 — unit tests for the pure tailscale-serve arg builders (no spawn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeServePath, tailscaleServeArgs } from "./providers.js";

test("normalizeServePath: root/empty/undefined → undefined (serve at /)", () => {
    assert.equal(normalizeServePath(undefined), undefined);
    assert.equal(normalizeServePath(""), undefined);
    assert.equal(normalizeServePath("  "), undefined);
    assert.equal(normalizeServePath("/"), undefined);
    assert.equal(normalizeServePath(42), undefined);
});

test("normalizeServePath: adds leading slash, strips trailing", () => {
    assert.equal(normalizeServePath("aiball"), "/aiball");
    assert.equal(normalizeServePath("/aiball"), "/aiball");
    assert.equal(normalizeServePath("/aiball/"), "/aiball");
    assert.equal(normalizeServePath("  /aiball  "), "/aiball");
});

test("tailscaleServeArgs: root (no path) = historical serve at /", () => {
    assert.deepEqual(
        tailscaleServeArgs("https", 443, "127.0.0.1:7777"),
        ["serve", "--bg", "--https=443", "127.0.0.1:7777"],
    );
});

test("tailscaleServeArgs: path adds --set-path, frees / on the port", () => {
    assert.deepEqual(
        tailscaleServeArgs("https", 443, "127.0.0.1:7777", "/aiball"),
        ["serve", "--bg", "--https=443", "--set-path=/aiball", "127.0.0.1:7777"],
    );
});

test("tailscaleServeArgs: http mode + custom port", () => {
    assert.deepEqual(
        tailscaleServeArgs("http", 8080, "127.0.0.1:7777", "/aiball"),
        ["serve", "--bg", "--http=8080", "--set-path=/aiball", "127.0.0.1:7777"],
    );
});
