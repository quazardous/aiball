/**
 * #1435 slice 5 — the daemon persists an agent's multi-agent role from the
 * `x-aiball-role` request header (like no_claim), so the UI can show it. Runs
 * in bearerAuth on every authenticated request; update-on-change both ways;
 * only lead/crew accepted; absence never clears. Spawns the real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1435s5-"));

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");

getDb();
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "worker", label: "s5" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Any authenticated /api/* request runs bearerAuth → readRoleHint. Hit a cheap
// authed endpoint; the persist happens in the middleware regardless of the body.
function ping(role?: string): Promise<Response> {
    return fetch(`${BASE}/api/subscriptions?consumer_id=worker`, {
        headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(role ? { "x-aiball-role": role } : {}),
        },
    });
}

test("x-aiball-role: crew → persisted on the consumer", async () => {
    assert.equal(getConsumer("worker")?.role, null); // default
    await ping("crew");
    assert.equal(getConsumer("worker")?.role, "crew");
});

test("relaunch with a different role updates it (both ways)", async () => {
    await ping("lead");
    assert.equal(getConsumer("worker")?.role, "lead");
    await ping("crew");
    assert.equal(getConsumer("worker")?.role, "crew");
});

test("an unknown role value is ignored (role unchanged)", async () => {
    await ping("captain");
    assert.equal(getConsumer("worker")?.role, "crew");
});

test("absence of the header never clears the role", async () => {
    await ping(); // no x-aiball-role
    assert.equal(getConsumer("worker")?.role, "crew");
});
