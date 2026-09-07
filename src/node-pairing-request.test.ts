// #2084 — the pairing marker.
//
// What these pin is that it gets CONSUMED. David asked for the restart to be
// automatic and named the hazard in the same breath: "il faut bien consommer la
// demande pour pas avoir une boucle". A marker that outlives its request is a
// daemon that reconfigures and restarts itself forever, so every way out of a
// request has to clear it — including the ways that are failures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AIBALL_HOME is read when `paths.ts` is first loaded, so the temp home has to
// be in place before the import — hence the dynamic import below.
const home = mkdtempSync(join(tmpdir(), "aiball-pairing-"));
process.env.AIBALL_HOME = home;
const {
    clearPairingRequest,
    isPairingRequestAbandoned,
    loadPairingRequest,
    pairingRequestPath,
    savePairingRequest,
    PAIRING_ABANDON_AFTER_MS,
} = await import("./node-pairing-request.js");

const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const marker = (expiresMs: number) => ({
    url: "https://hub.example:8443",
    id: "abc123",
    code: "K7F-M92",
    expires_at: new Date(NOW + expiresMs).toISOString(),
    created_at: new Date(NOW).toISOString(),
});

test("nothing pending reads as nothing, not as an error", () => {
    clearPairingRequest();
    assert.equal(loadPairingRequest(), null);
});

test("a saved request comes back whole", () => {
    savePairingRequest({ ...marker(600_000), strict: true });
    const m = loadPairingRequest();
    assert.equal(m?.id, "abc123");
    assert.equal(m?.code, "K7F-M92");
    assert.equal(m?.strict, true);
});

test("clearing consumes it, and clearing twice is not an error", () => {
    savePairingRequest(marker(600_000));
    clearPairingRequest();
    assert.equal(loadPairingRequest(), null);
    clearPairingRequest();
    assert.equal(loadPairingRequest(), null, "still nothing, still no throw");
});

test("an unreadable marker is dropped rather than re-read every tick", () => {
    // It can never become readable, so keeping it would repeat one failure
    // forever — the shape of the loop these tests exist to prevent.
    writeFileSync(pairingRequestPath(), "{ not json", "utf8");
    assert.equal(loadPairingRequest(), null);
    assert.equal(existsSync(pairingRequestPath()), false, "and it is gone");
});

test("a marker missing its handle is dropped too", () => {
    writeFileSync(pairingRequestPath(), JSON.stringify({ url: "https://hub" }), "utf8");
    assert.equal(loadPairingRequest(), null);
    assert.equal(existsSync(pairingRequestPath()), false);
});

// #2088 — the give-up is for a hub that never answers, and it is NOT the
// expiry: the hub owns that. The check this replaced compared the hub's
// `expires_at` to the node's clock, so a node running ahead abandoned every
// request before asking once.
test("a hub deadline in the past does not abandon the request", () => {
    const ahead = { ...marker(-2 * 60 * 60_000), created_at: new Date(NOW).toISOString() };
    assert.equal(isPairingRequestAbandoned(ahead, NOW), false);
});

test("it gives up once it has been trying for an hour", () => {
    assert.equal(isPairingRequestAbandoned(marker(600_000), NOW), false);
    assert.equal(isPairingRequestAbandoned(marker(600_000), NOW + PAIRING_ABANDON_AFTER_MS), true);
});

test("an undatable marker counts as abandoned rather than immortal", () => {
    assert.equal(
        isPairingRequestAbandoned({ ...marker(600_000), created_at: "not a date" }, NOW),
        true,
    );
});
