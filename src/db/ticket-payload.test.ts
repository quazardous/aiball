// #2109 — the payload zone's rules. Pure, so these run without a daemon.
import test from "node:test";
import assert from "node:assert/strict";
import {
    SECRET_PREVIEW_CHARS,
    canReadPayloadSecrets,
    filterPayload,
    isRedacted,
    parsePublicKeys,
    payloadAccessState,
    redactValue,
} from "./ticket-payload.js";

test("no schema means every key is secret", () => {
    const keys = parsePublicKeys(null);
    const out = filterPayload({ api_key: "sk-ant-api03-xxxxxxxx", endpoint: "https://x.example" }, keys);
    assert.equal(isRedacted(out.api_key), true);
    assert.equal(isRedacted(out.endpoint), true);
});

test("a malformed schema falls to the safe side, not the open one", () => {
    for (const bad of ["{}", "null", "not json", '"endpoint"', "[1,2]"]) {
        assert.deepEqual(parsePublicKeys(bad), [], `schema ${bad} must publish nothing`);
    }
    // A partially valid array keeps only its strings.
    assert.deepEqual(parsePublicKeys('["endpoint", 3, null]'), ["endpoint"]);
});

test("the schema publishes the keys it names, and only those", () => {
    const out = filterPayload(
        { endpoint: "https://x.example", api_key: "sk-ant-api03-xxxxxxxx" },
        parsePublicKeys('["endpoint"]'),
    );
    assert.equal(out.endpoint, "https://x.example");
    assert.equal(isRedacted(out.api_key), true);
});

test("keys stay visible even when every value is hidden", () => {
    const out = filterPayload({ api_key: "sk-ant-api03-xxxxxxxx", token: "ghp_aaaaaaaaaaaa" }, []);
    assert.deepEqual(Object.keys(out).sort(), ["api_key", "token"]);
});

test("a preview is a fixed prefix, and a short secret gets none", () => {
    const long = redactValue("sk-ant-api03-xxxxxxxx");
    assert.equal(long.preview, "sk-ant-api03-xxxxxxxx".slice(0, SECRET_PREVIEW_CHARS));
    // Too short to preview without giving away a large share of it.
    assert.equal(redactValue("hunter2").preview, null);
    // Non-strings have no beginning to show.
    assert.equal(redactValue({ nested: true }).preview, null);
    assert.equal(redactValue(42).preview, null);
});

test("a redacted value never carries the original", () => {
    const secret = "sk-ant-api03-abcdefghijklmnop";
    const out = filterPayload({ api_key: secret }, []);
    assert.equal(JSON.stringify(out).includes(secret), false);
});

test("reporter, assignee and humans read secrets; a claimant does not", () => {
    const ticket = { by_agent: "m2m-bs", assignee: "jobbox-win" };
    assert.equal(canReadPayloadSecrets(ticket, "m2m-bs", false), true, "reporter deposited it");
    assert.equal(canReadPayloadSecrets(ticket, "jobbox-win", false), true, "a human assigned it");
    assert.equal(canReadPayloadSecrets(ticket, "david", true), true, "moderator");
    assert.equal(canReadPayloadSecrets(ticket, "passer-by", false), false);
});

test("claiming a ticket does not open its vault", () => {
    // The load-bearing case: claim is self-service (any agent, any approved
    // ticket), so a predicate that honoured it would hand the vault to whoever
    // asked. Assignment is moderator-only, which is why only it counts.
    const ticket = { by_agent: "m2m-bs", assignee: null, claimant: "opportunist" };
    assert.equal(canReadPayloadSecrets(ticket, "opportunist", false), false);
});

test("an empty consumer id is nobody, not everybody", () => {
    assert.equal(canReadPayloadSecrets({ by_agent: null, assignee: null }, "", false), false);
});

test("closing the ticket ends access; revocation outranks it", () => {
    assert.equal(payloadAccessState({ closed: false }, {}), "open");
    assert.equal(payloadAccessState({ closed: true }, {}), "ticket-closed");
    assert.equal(payloadAccessState({ closed: true }, { revoked_at: "2026-09-07T00:00:00Z" }), "revoked");
    assert.equal(payloadAccessState({ closed: false }, { revoked_at: "2026-09-07T00:00:00Z" }), "revoked");
});
