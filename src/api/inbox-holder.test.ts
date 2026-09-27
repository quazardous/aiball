/**
 * #3038 — every inbox row and the ticket header say who holds the ticket now,
 * and how: `assigned`, a live `claim`, a `lapsed_claim` (still on record,
 * holding nothing), or nothing. One rule for both, the header's.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3038-"));
process.env.AIBALL_SOCK = "";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { holding } = await import("../db/claim-hold.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-3038";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3038-h" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get(path: string): Promise<unknown> {
    return (await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${HUMAN}` } })).json();
}
function ticket(title: string, hold: { assignee?: string; claimant?: string; claimedAt?: string } = {}): number {
    const id = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
    getDb().update(schema.tickets).set({
        assignee: hold.assignee ?? null,
        claimant: hold.claimant ?? null,
        claimedAt: hold.claimedAt ?? null,
    }).where(eq(schema.tickets.id, id)).run();
    return id;
}
type Held = { holder: string | null; held_as: string | null };
async function rowOf(id: number): Promise<Held> {
    const rows = await get(`/api/inbox?ids=${id}&project=${P}`) as (Held & { id: number })[];
    const r = rows.find((x) => x.id === id)!;
    return { holder: r.holder, held_as: r.held_as };
}
async function headerOf(id: number): Promise<Held> {
    const t = (await get(`/api/tickets/${id}`) as { ticket: Held }).ticket;
    return { holder: t.holder, held_as: t.held_as };
}

const cases: [string, Parameters<typeof ticket>[1], Held][] = [
    ["nobody holds it", {}, { holder: null, held_as: null }],
    ["assigned", { assignee: "worker" }, { holder: "worker", held_as: "assigned" }],
    ["a live claim", { claimant: "worker", claimedAt: new Date().toISOString() }, { holder: "worker", held_as: "claim" }],
    ["a claim that lapsed", { claimant: "worker", claimedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() }, { holder: null, held_as: "lapsed_claim" }],
    ["an assignment outranks a claim", { assignee: "boss", claimant: "worker", claimedAt: new Date().toISOString() }, { holder: "boss", held_as: "assigned" }],
];

for (const [name, hold, expected] of cases) {
    test(`${name}: the row and the header agree`, async () => {
        const id = ticket(name, hold);
        assert.deepEqual(await rowOf(id), expected, "row");
        assert.deepEqual(await headerOf(id), expected, "header");
    });
}

test("the rule, alone: a claim held until a moment is live before it, lapsed after", () => {
    const t = { assignee: null, claimant: "worker" };
    assert.deepEqual(holding(t, 2_000, 1_000), { holder: "worker", held_as: "claim" });
    assert.deepEqual(holding(t, 2_000, 3_000), { holder: null, held_as: "lapsed_claim" });
    assert.deepEqual(holding(t, null, 1_000), { holder: null, held_as: "lapsed_claim" });
});
