// #2282 — `/api/auth/status` reports when the open install token lapses, and an
// expired row (still waiting for the purge) no longer counts as open.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-auth-status-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken, deleteToken, listTokens } = await import("../db/tokens.js");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
    server.close();
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});

type Status = { ready: boolean; install_available: boolean; install_expires_at: string | null };
const status = async (): Promise<Status> => (await fetch(`${BASE}/api/auth/status`)).json() as Promise<Status>;

function clearInstalls(): void {
    for (const t of listTokens({ kind: "install" })) deleteToken(t.token);
}

test("an open install token reports its expiry, the latest one when several are open", async () => {
    clearInstalls();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 7200_000).toISOString();
    issueToken({ kind: "install", label: "a", expires_at: soon });
    issueToken({ kind: "install", label: "b", expires_at: later });
    const s = await status();
    assert.equal(s.install_available, true);
    assert.equal(s.install_expires_at, later);
});

test("an expired install token is not open, and has no expiry to report", async () => {
    clearInstalls();
    issueToken({ kind: "install", label: "stale", expires_at: new Date(Date.now() - 60_000).toISOString() });
    const s = await status();
    assert.equal(s.install_available, false);
    assert.equal(s.install_expires_at, null);
});
