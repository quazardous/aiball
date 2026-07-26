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
    type SessionResolveInput,
} from "./session-id.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const never = () => false;
const always = () => true;
const noPersist = () => null;
const persisted = (id: string | null) => () => id;

function inp(over: Partial<SessionResolveInput>): SessionResolveInput {
    return {
        mode: "auto",
        configuredId: "",
        loopName: "aiball/lead@/home/x",
        sessionExists: never,
        readPersistedId: noPersist,
        ...over,
    };
}

test("normalizeSessionMode: known values pass, everything else → auto", () => {
    assert.equal(normalizeSessionMode("legacy"), "legacy");
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
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(isValidUuid(a), `derived id must be a valid UUID, got ${a}`);
    assert.equal(a[14], "5", "version nibble is 5 (v5)");
    assert.ok(/[89ab]/.test(a[19]), "variant nibble is RFC-4122");
});

test("legacy → empty plan (caller runs always_resume)", () => {
    const p = resolveSession(inp({ mode: "legacy" }));
    assert.equal(p.mode, "legacy");
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
});

test("auto, first run (no persisted id) → empty plan (fresh; hook will persist)", () => {
    const p = resolveSession(inp({ mode: "auto", readPersistedId: noPersist }));
    assert.equal(p.mode, "auto");
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
});

test("auto, persisted id present → --resume <id> (lowercased)", () => {
    const p = resolveSession(inp({ mode: "auto", readPersistedId: persisted(UUID.toUpperCase()) }));
    assert.equal(p.sessionId, UUID);
    assert.deepEqual(p.args, ["--resume", UUID]);
});

test("auto, persisted garbage → treated as first run (empty)", () => {
    const p = resolveSession(inp({ mode: "auto", readPersistedId: persisted("not-a-uuid") }));
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
});

test("managed, first run → --session-id <derived>", () => {
    const p = resolveSession(inp({ mode: "managed", sessionExists: never }));
    assert.equal(p.mode, "managed");
    assert.equal(p.sessionId, deterministicSessionId("aiball/lead@/home/x"));
    assert.deepEqual(p.args, ["--session-id", p.sessionId]);
});

test("managed, session exists → --resume <derived>", () => {
    const p = resolveSession(inp({ mode: "managed", sessionExists: always }));
    assert.deepEqual(p.args, ["--resume", p.sessionId]);
});

test("fixed with a valid id, first run → --session-id <id>", () => {
    const p = resolveSession(inp({ mode: "fixed", configuredId: UUID.toUpperCase(), sessionExists: never }));
    assert.equal(p.sessionId, UUID);
    assert.deepEqual(p.args, ["--session-id", UUID]);
});

test("fixed with a valid id, exists → --resume <id>", () => {
    const p = resolveSession(inp({ mode: "fixed", configuredId: UUID, sessionExists: always }));
    assert.deepEqual(p.args, ["--resume", UUID]);
});

test("fixed with invalid id → downgrade to auto + warning (uses persisted if any)", () => {
    const p = resolveSession(inp({ mode: "fixed", configuredId: "nope", readPersistedId: noPersist }));
    assert.equal(p.mode, "auto");
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
    assert.match(p.warning ?? "", /fixed/);

    const p2 = resolveSession(inp({ mode: "fixed", configuredId: "nope", readPersistedId: persisted(UUID) }));
    assert.equal(p2.mode, "auto");
    assert.deepEqual(p2.args, ["--resume", UUID]);
});
