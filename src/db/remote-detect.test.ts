// #422 — pure remote-detection. node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRemoteConsumer, isLoopbackAddr } from "./remote-detect.js";

test("isLoopbackAddr: loopback families", () => {
    assert.equal(isLoopbackAddr("127.0.0.1"), true);
    assert.equal(isLoopbackAddr("::1"), true);
    assert.equal(isLoopbackAddr("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddr("192.168.1.5"), false);
    assert.equal(isLoopbackAddr("100.64.0.3"), false); // tailscale CGNAT range
    assert.equal(isLoopbackAddr(null), false);
    assert.equal(isLoopbackAddr(undefined), false);
});

test("isRemoteConsumer: node is always remote", () => {
    assert.equal(isRemoteConsumer("node", "100.64.0.3"), true);
    assert.equal(isRemoteConsumer("node", null), true);
});

test("isRemoteConsumer: tcp depends on the peer ip", () => {
    assert.equal(isRemoteConsumer("tcp", "192.168.1.5"), true);
    assert.equal(isRemoteConsumer("tcp", "100.64.0.3"), true); // tailnet → remote
    assert.equal(isRemoteConsumer("tcp", "127.0.0.1"), false); // localhost tcp → local
    assert.equal(isRemoteConsumer("tcp", "::1"), false);
});

test("isRemoteConsumer: uds / unknown → local", () => {
    assert.equal(isRemoteConsumer("uds", null), false);
    assert.equal(isRemoteConsumer(null, null), false);
    assert.equal(isRemoteConsumer(undefined, "1.2.3.4"), false); // unknown via, never tracked
});
