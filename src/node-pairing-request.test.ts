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
    isPairingRequestLive,
    loadPairingRequest,
    pairingRequestPath,
    savePairingRequest,
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

test("liveness follows the deadline, not the file", () => {
    assert.equal(isPairingRequestLive(marker(1), NOW), true);
    assert.equal(isPairingRequestLive(marker(0), NOW), false, "dead at the boundary");
    assert.equal(isPairingRequestLive(marker(-60_000), NOW), false);
});

test("an unparseable deadline counts as dead", () => {
    // Better to stop asking than to poll a hub forever about a request whose
    // expiry nobody can read.
    assert.equal(
        isPairingRequestLive({ ...marker(600_000), expires_at: "not a date" }, NOW),
        false,
    );
});
