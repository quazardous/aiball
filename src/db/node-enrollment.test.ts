// #2074 — the pairing rules.
//
// The door is unauthenticated by necessity, so what these pin is when it is
// SHUT: an unattended request stops being one, and an approved token is handed
// over once.
import test from "node:test";
import assert from "node:assert/strict";
import {
    ENROLLMENT_RETENTION_MS,
    ENROLLMENT_TTL_MS,
    enrollmentState,
    isCollectable,
    isDecidable,
    isForgettable,
    makePairingCode,
} from "./node-enrollment.js";

const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

test("a fresh request waits for a human", () => {
    const row = { status: "pending", expires_at: at(ENROLLMENT_TTL_MS) };
    assert.equal(enrollmentState(row, NOW), "pending");
    assert.equal(isDecidable(row, NOW), true);
    assert.equal(isCollectable(row, NOW), false);
});

test("nobody approved it in time — it stops being a door", () => {
    const row = { status: "pending", expires_at: at(-1) };
    assert.equal(enrollmentState(row, NOW), "expired");
    assert.equal(isDecidable(row, NOW), false);
    assert.equal(isCollectable(row, NOW), false);
});

test("an approval already granted survives the expiry", () => {
    // The human has decided; a node slow to poll must not have to ask again.
    // Expiry closes an UNATTENDED door, it doesn't revoke a decision.
    const row = { status: "approved", expires_at: at(-1) };
    assert.equal(enrollmentState(row, NOW), "approved");
    assert.equal(isCollectable(row, NOW), true);
});

test("the token is handed over once", () => {
    const row = { status: "approved", expires_at: at(ENROLLMENT_TTL_MS), delivered_at: at(-10) };
    assert.equal(enrollmentState(row, NOW), "delivered");
    assert.equal(isCollectable(row, NOW), false);
});

test("a refusal is final, whatever else is true of the row", () => {
    assert.equal(
        enrollmentState({ status: "rejected", expires_at: at(ENROLLMENT_TTL_MS) }, NOW),
        "rejected",
    );
    assert.equal(
        enrollmentState({ status: "rejected", expires_at: at(-1), delivered_at: at(-5) }, NOW),
        "rejected",
    );
});

// #2079 — expiring and being forgotten are two different moments. A request
// stops being a door after ten minutes; it stops being NEWS much later, because
// the human it was waiting for is by definition not always at the screen.
test("an expired request is still worth showing for a while", () => {
    const row = { status: "pending", expires_at: at(-60_000) };
    assert.equal(enrollmentState(row, NOW), "expired", "no longer a door…");
    assert.equal(isDecidable(row, NOW), false, "…and not approvable…");
    assert.equal(isForgettable(row, NOW), false, "…but still shown");
});

test("past the retention window it is forgotten", () => {
    assert.equal(
        isForgettable({ status: "pending", expires_at: at(-ENROLLMENT_RETENTION_MS) }, NOW),
        true,
        "forgotten at the boundary, not after it",
    );
    assert.equal(
        isForgettable({ status: "pending", expires_at: at(-ENROLLMENT_RETENTION_MS + 1000) }, NOW),
        false,
    );
});

test("only an expired request is ever forgotten", () => {
    // A decided one is the panel's own audit of a credential coming into
    // existence; retention must not quietly prune that.
    const old = at(-ENROLLMENT_RETENTION_MS * 10);
    assert.equal(isForgettable({ status: "approved", expires_at: old }, NOW), false);
    assert.equal(isForgettable({ status: "rejected", expires_at: old }, NOW), false);
    assert.equal(
        isForgettable({ status: "approved", expires_at: old, delivered_at: old }, NOW),
        false,
    );
    assert.equal(isForgettable({ status: "pending", expires_at: at(60_000) }, NOW), false);
});

test("the code avoids the characters people read back wrongly", () => {
    // It exists to be compared out loud between two screens, so O/0 and I/1/L
    // would defeat its only purpose.
    for (let i = 0; i < 400; i++) {
        const code = makePairingCode();
        assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/, code);
        assert.equal(/[ILOU01]/.test(code), false, `${code} contains a confusable`);
    }
});

test("codes differ — a fixed code would make comparing it pointless", () => {
    const seen = new Set(Array.from({ length: 200 }, () => makePairingCode()));
    assert.ok(seen.size > 150, `only ${seen.size} distinct codes out of 200`);
});
