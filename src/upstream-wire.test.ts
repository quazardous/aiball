// #1563 slice 3 — the selection rule. The valuable cases are the ones where a
// naive implementation would "helpfully" pick a different wire than asked.
//
// Run: `npx tsx --test src/upstream-wire.test.ts`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { probeAllWires, resolveWire, resetWireCache } from "./upstream-wire.js";
import { runCommand, type UpstreamTransport } from "./upstream-transport.js";

/** A transport stub that records whether it was probed. */
function stub(id: "http" | "gh", ok: boolean, detail = `${id}: stub`) {
    const t = {
        id,
        probes: 0,
        transport: null as unknown as UpstreamTransport,
    };
    t.transport = {
        id,
        async probe() { t.probes++; return { ok, detail }; },
        async request() { return { status: 200, json: null }; },
    };
    return t;
}

beforeEach(() => resetWireCache());

test("auto prefers gh — the wire that needs no secret on disk", async () => {
    const gh = stub("gh", true, "gh: authenticated as someone");
    const http = stub("http", true);
    const { wire, decision } = await resolveWire({
        choice: "auto", quiet: true,
        transports: { gh: gh.transport, http: http.transport },
    });
    assert.equal(wire.id, "gh");
    assert.equal(decision.via, "probed");
    assert.match(decision.detail, /authenticated/);
});

test("auto falls back to http when gh isn't usable", async () => {
    const gh = stub("gh", false, "gh: not installed (or not on PATH)");
    const http = stub("http", true);
    const { wire, decision } = await resolveWire({
        choice: "auto", quiet: true,
        transports: { gh: gh.transport, http: http.transport },
    });
    assert.equal(wire.id, "http");
    // Both probes are reported, so a diagnostic can say WHY gh lost.
    assert.equal(decision.probes.length, 2);
    assert.match(decision.probes.find((p) => p.id === "gh")!.detail, /not installed/);
});

test("auto probes ONCE per process, then reuses the decision", async () => {
    const gh = stub("gh", true);
    const http = stub("http", true);
    const args = { choice: "auto" as const, quiet: true, transports: { gh: gh.transport, http: http.transport } };
    await resolveWire(args);
    await resolveWire(args);
    await resolveWire(args);
    assert.equal(gh.probes, 1, "a poller must not re-probe on every call");
});

test("an explicit gh that is BROKEN is still used — no silent fallback to http", async () => {
    const gh = stub("gh", false, "gh: installed but not authenticated");
    const http = stub("http", true);
    const { wire, decision } = await resolveWire({
        choice: "gh", quiet: true,
        transports: { gh: gh.transport, http: http.transport },
    });
    assert.equal(wire.id, "gh", "asking for gh and silently getting http would hide a broken gh for weeks");
    assert.equal(decision.via, "configured");
    assert.equal(http.probes, 0, "the other wire isn't even probed on an explicit choice");
});

test("an explicit choice never consults the auto cache", async () => {
    const gh = stub("gh", true);
    const http = stub("http", true);
    const transports = { gh: gh.transport, http: http.transport };
    await resolveWire({ choice: "auto", quiet: true, transports });   // caches gh
    const { wire } = await resolveWire({ choice: "http", quiet: true, transports });
    assert.equal(wire.id, "http");
});

test("probeAllWires reports every wire, not just the selected one", async () => {
    const gh = stub("gh", false, "gh: not installed (or not on PATH)");
    const http = stub("http", true, "http: no token");
    const { choice, probes } = await probeAllWires({
        choice: "auto",
        transports: { gh: gh.transport, http: http.transport },
    });
    assert.equal(choice, "auto");
    assert.deepEqual(probes.map((p) => p.id), ["gh", "http"]);
    assert.deepEqual(probes.map((p) => p.ok), [false, true]);
});

// --- the timeout, against a real child ------------------------------------

test("a child that never exits is killed and REJECTS instead of hanging forever", async () => {
    const started = Date.now();
    await assert.rejects(
        () => runCommand("sleep", ["30"], undefined, 150),
        /timed out after 150ms \(killed\)/,
    );
    assert.ok(Date.now() - started < 5_000, "it must not wait for the child");
});

test("a fast child still resolves normally — the timer doesn't interfere", async () => {
    const r = await runCommand("echo", ["hi"], undefined, 5_000);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "hi");
});
