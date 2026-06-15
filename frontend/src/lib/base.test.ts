// #190 — unit tests for the pure base-path helpers (no import.meta needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBase, stripBaseFrom } from "./base";

test("joinBase: root base = no prefix", () => {
    assert.equal(joinBase("", "/api/x"), "/api/x");
    assert.equal(joinBase("", "/b/1"), "/b/1");
});

test("joinBase: sub-path base prefixes app-absolute paths", () => {
    assert.equal(joinBase("/aiball", "/api/x"), "/aiball/api/x");
    assert.equal(joinBase("/aiball", "/b/1"), "/aiball/b/1");
    assert.equal(joinBase("/aiball", "/"), "/aiball/");
});

test("stripBaseFrom: root base = pathname unchanged", () => {
    assert.equal(stripBaseFrom("", "/b/1"), "/b/1");
    assert.equal(stripBaseFrom("", "/"), "/");
});

test("stripBaseFrom: strips the sub-path base", () => {
    assert.equal(stripBaseFrom("/aiball", "/aiball/b/1"), "/b/1");
    assert.equal(stripBaseFrom("/aiball", "/aiball/general"), "/general");
    assert.equal(stripBaseFrom("/aiball", "/aiball"), "/");
});

test("stripBaseFrom: paths outside the base are left unchanged", () => {
    // No false-positive on a path that merely starts with the same letters.
    assert.equal(stripBaseFrom("/aiball", "/aiballx/b/1"), "/aiballx/b/1");
    assert.equal(stripBaseFrom("/aiball", "/other"), "/other");
});

test("joinBase ∘ stripBaseFrom round-trips", () => {
    const base = "/aiball";
    for (const p of ["/", "/b/1", "/general", "/api/tickets"]) {
        assert.equal(stripBaseFrom(base, joinBase(base, p)), p);
    }
});
