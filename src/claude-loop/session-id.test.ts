/**
 * #1549 — session-id resolution (pure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeSessionMode,
    isValidUuid,
    deterministicSessionId,
    resolveSession,
} from "./session-id.js";

const never = () => false;
const always = () => true;

test("normalizeSessionMode: known values pass, everything else → auto", () => {
    assert.equal(normalizeSessionMode("managed"), "managed");
    assert.equal(normalizeSessionMode("FIXED"), "fixed");
    assert.equal(normalizeSessionMode(" auto "), "auto");
    assert.equal(normalizeSessionMode(""), "auto");
    assert.equal(normalizeSessionMode(null), "auto");
    assert.equal(normalizeSessionMode("bogus"), "auto");
});

test("deterministicSessionId: stable + valid UUID + distinct per key", () => {
    const a = deterministicSessionId("aiball/lead@/home/x");
    const b = deterministicSessionId("aiball/lead@/home/x");
    const c = deterministicSessionId("aiball/crew-infra@/home/x");
    assert.equal(a, b, "same key ⇒ same id");
    assert.notEqual(a, c, "different key ⇒ different id");
    assert.ok(isValidUuid(a), `derived id must be a valid UUID, got ${a}`);
    assert.equal(a[14], "5", "version nibble is 5 (v5)");
    assert.ok(/[89ab]/.test(a[19]), "variant nibble is RFC-4122");
});

test("auto mode → empty plan (caller keeps its own resume path)", () => {
    const p = resolveSession({ mode: "auto", configuredId: "", loopName: "n", sessionExists: never });
    assert.equal(p.mode, "auto");
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
});

test("managed, first run (no session yet) → --session-id <derived>", () => {
    const p = resolveSession({ mode: "managed", configuredId: "", loopName: "aiball/lead", sessionExists: never });
    assert.equal(p.mode, "managed");
    assert.ok(isValidUuid(p.sessionId!));
    assert.deepEqual(p.args, ["--session-id", p.sessionId]);
});

test("managed, session exists → --resume <derived>", () => {
    const p = resolveSession({ mode: "managed", configuredId: "", loopName: "aiball/lead", sessionExists: always });
    assert.deepEqual(p.args, ["--resume", p.sessionId]);
});

test("managed id is the derived id for the loop name", () => {
    const name = "aiball/crew-infra@/home/x/wt";
    const p = resolveSession({ mode: "managed", configuredId: "", loopName: name, sessionExists: never });
    assert.equal(p.sessionId, deterministicSessionId(name));
});

test("fixed with a valid id, first run → --session-id <id> (lowercased)", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const p = resolveSession({ mode: "fixed", configuredId: id.toUpperCase(), loopName: "n", sessionExists: never });
    assert.equal(p.sessionId, id);
    assert.deepEqual(p.args, ["--session-id", id]);
});

test("fixed with a valid id, exists → --resume <id>", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const p = resolveSession({ mode: "fixed", configuredId: id, loopName: "n", sessionExists: always });
    assert.deepEqual(p.args, ["--resume", id]);
});

test("fixed with a missing/invalid id → downgrade to auto + warning", () => {
    const p = resolveSession({ mode: "fixed", configuredId: "not-a-uuid", loopName: "n", sessionExists: never });
    assert.equal(p.mode, "auto");
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
    assert.match(p.warning ?? "", /fixed/);
});
