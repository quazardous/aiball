import { test } from "node:test";
import assert from "node:assert/strict";
import {
    presenceConnect,
    presenceDisconnect,
    isPresent,
    presenceRunning,
    presenceSource,
    __resetPresence,
} from "./live-presence.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #395: presence registry — near-realtime loop liveness.
test("#395 presence: connect → live edge, refcount, disconnect after grace → stop", async () => {
    process.env.AIBALL_PRESENCE_GRACE_MS = "10";
    __resetPresence();

    // First connect = a real edge (caller broadcasts running:true).
    assert.deepEqual(presenceConnect("alice"), { becameLive: true });
    assert.equal(isPresent("alice"), true);
    assert.equal(presenceRunning("alice"), true);

    // A second connection (reconnect overlap) is NOT a new edge.
    assert.deepEqual(presenceConnect("alice"), { becameLive: false });

    // One disconnect: still one live connection → stays present.
    presenceDisconnect("alice");
    assert.equal(isPresent("alice"), true);

    // Last disconnect: present during grace, then gone (authoritative stop).
    presenceDisconnect("alice");
    assert.equal(isPresent("alice"), true, "still present within grace");
    await sleep(30);
    assert.equal(isPresent("alice"), false, "gone after grace");
    assert.equal(presenceRunning("alice"), false, "seen-then-gone overrides heartbeat");
});

test("#395 presence: reconnect within grace cancels the stop (no flap)", async () => {
    process.env.AIBALL_PRESENCE_GRACE_MS = "40";
    __resetPresence();

    presenceConnect("bob");
    presenceDisconnect("bob"); // count→0, grace armed
    await sleep(10); // still within grace
    presenceConnect("bob"); // reconnect cancels the grace timer
    await sleep(60); // past the original grace window
    assert.equal(isPresent("bob"), true, "reconnect kept it live, no stop");
    assert.equal(presenceRunning("bob"), true);
});

test("#395 presence: never-seen consumer → null verdict (caller uses heartbeat)", () => {
    __resetPresence();
    assert.equal(presenceRunning("never"), null);
    assert.equal(isPresent("never"), false);
});

test("#395 presence: ui source wins over terminal, recorded for jvdxez", () => {
    __resetPresence();
    presenceConnect("carol", "terminal");
    assert.equal(presenceSource("carol"), "terminal");
    presenceConnect("carol", "ui"); // a UI-launched connection upgrades the label
    assert.equal(presenceSource("carol"), "ui");
});
