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

test("auto, persisted id present AND its transcript exists → --resume <id> (lowercased)", () => {
    const p = resolveSession(inp({
        mode: "auto",
        readPersistedId: persisted(UUID.toUpperCase()),
        sessionExists: always,
    }));
    assert.equal(p.sessionId, UUID);
    assert.deepEqual(p.args, ["--resume", UUID]);
    assert.equal(p.warning, null);
});

// #1587 — the case that cost a morning. `.aiball-session_id` lives in the
// project cwd and outlives the transcript it names, so a well-formed id is not
// a live one. Resuming a pruned session makes claude exit at once, the pane
// dies, the mux session is reaped, and the kernel stops on `watchdog:tmux-gone`
// — a loop that refuses to start with nothing on screen but the shell prompt.
test("auto, persisted id whose transcript is GONE → fresh session + warning", () => {
    const p = resolveSession(inp({
        mode: "auto",
        readPersistedId: persisted(UUID),
        sessionExists: never,
    }));
    assert.equal(p.mode, "auto");
    assert.equal(p.sessionId, null, "must not resume an id with no transcript");
    assert.deepEqual(p.args, [], "no --resume at all — a fresh session is the fallback");
    assert.match(p.warning ?? "", /no longer exists/);
    assert.match(p.warning ?? "", new RegExp(UUID), "the warning names the stale id");
});

test("auto, the existence probe is asked for the PERSISTED id, not something else", () => {
    const asked: string[] = [];
    resolveSession(inp({
        mode: "auto",
        readPersistedId: persisted(UUID.toUpperCase()),
        sessionExists: (id) => { asked.push(id); return true; },
    }));
    assert.deepEqual(asked, [UUID], "probed with the lowercased persisted id");
});

test("auto, persisted garbage → treated as first run (empty), probe not even consulted", () => {
    let probed = false;
    const p = resolveSession(inp({
        mode: "auto",
        readPersistedId: persisted("not-a-uuid"),
        sessionExists: () => { probed = true; return true; },
    }));
    assert.equal(p.sessionId, null);
    assert.deepEqual(p.args, []);
    assert.equal(probed, false, "a malformed id is rejected before any fs probe");
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
