/**
 * #3063 — a route that serves a bus method names one that exists, and answers
 * as the bus does: the same result, the same refusal, for the same caller.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-3063-served-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { servedMethods } = await import("./http.js");
const { getMethod } = await import("./methods.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { submitMessage } = await import("../messages.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "auth", consumer_id: "boss", label: "served" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "served" }).token;
createProject({ name: "p-served" });
const T = submitMessage({ project: "p-served", kind: "ticket_created", title: "t", body: "b", by_agent: "worker" }).id;

const server = createServer(createApp());
attachBus(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const clients: Awaited<ReturnType<typeof BusClient.connect>>[] = [];
after(() => {
    for (const c of clients) c.close();
    server.closeAllConnections();
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("every method a route serves exists", () => {
    const names = [...servedMethods()];
    assert.ok(names.length > 0, "the routes were loaded");
    assert.deepEqual(names.filter((n) => !getMethod(n)), []);
});

/** Fields that move between two reads a few ms apart. */
function stripVolatile(v: unknown): unknown {
    return JSON.parse(JSON.stringify(v, (k, x) => (k === "ts" || k === "hot_until" ? undefined : x)));
}

async function http(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; total: string | null }> {
    const r = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown>, total: r.headers.get("x-total-count") };
}

async function bus(token: string, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; status: number; code: string; message: string }> {
    const c = await BusClient.connect({ url, token });
    clients.push(c);
    try {
        return { ok: true, result: await c.call(method, params) };
    } catch (e) {
        const b = e as { status: number; code: string; message: string };
        return { ok: false, status: b.status, code: b.code, message: b.message };
    }
}

const cases: { name: string; token: string; http: [string, string, unknown?]; bus: [string, unknown] }[] = [
    { name: "tags", token: AGENT, http: ["GET", "/api/tags"], bus: ["tag.list", {}] },
    { name: "mentions", token: AGENT, http: ["GET", "/api/mention-suggestions"], bus: ["mention.suggestions", {}] },
    { name: "milestones", token: AGENT, http: ["GET", "/api/projects/p-served/milestones"], bus: ["project.milestones", { project: "p-served" }] },
    { name: "a message", token: AGENT, http: ["GET", `/api/messages/${T}`], bus: ["message.get", { id: T }] },
    { name: "no such message", token: AGENT, http: ["GET", "/api/messages/999999"], bus: ["message.get", { id: 999999 }] },
    { name: "another agent's backlog", token: AGENT, http: ["GET", "/api/consumers/boss/backlog"], bus: ["consumer.backlog", { consumer_id: "boss" }] },
    { name: "an agent snoozing", token: AGENT, http: ["POST", `/api/tickets/${T}/postpone`, { until: "2099-01-01T00:00:00Z" }], bus: ["ticket.postpone", { id: T, until: "2099-01-01T00:00:00Z" }] },
    { name: "a loop control by an agent", token: AGENT, http: ["POST", "/api/agents/worker/afk", { action: "off" }], bus: ["consumer.afk", { name: "worker", action: "off" }] },
    { name: "the inbox, turn view", token: AGENT, http: ["GET", "/api/inbox?project=p-served&view=turn"], bus: ["inbox.list", { project: "p-served", view: "turn" }] },
    { name: "a ticket header", token: AGENT, http: ["GET", `/api/tickets/${T}`], bus: ["ticket.get", { id: T }] },
    { name: "a ticket, full", token: HUMAN, http: ["GET", `/api/tickets/${T}?full=1`], bus: ["ticket.get", { id: T, full: true }] },
    { name: "a ticket, digest", token: HUMAN, http: ["GET", `/api/tickets/${T}?digest=1&digest_limit=2`], bus: ["ticket.get", { id: T, digest: true, digest_limit: 2 }] },
    { name: "no such ticket", token: AGENT, http: ["GET", "/api/tickets/999999"], bus: ["ticket.get", { id: 999999 }] },
    { name: "a post with no kind", token: AGENT, http: ["POST", "/api/messages", { project: "p-served", body: "b" }], bus: ["message.post", { project: "p-served", body: "b" }] },
    { name: "a post naming another author", token: AGENT, http: ["POST", "/api/messages", { by_agent: "boss", kind: "comment_added", project: "p-served", ticket_id: T, body: "b" }], bus: ["message.post", { by_agent: "boss", kind: "comment_added", project: "p-served", ticket_id: T, body: "b" }] },
    { name: "deciding a ticket head", token: HUMAN, http: ["POST", `/api/messages/${T}/decide`, { status: "accepted" }], bus: ["message.decide", { id: T, status: "accepted" }] },
    { name: "an agent pushing a ticket to another", token: AGENT, http: ["POST", `/api/tickets/${T}/assign`, { assignee: "boss" }], bus: ["ticket.assign", { id: T, assignee: "boss" }] },
    { name: "a ticket related to itself", token: HUMAN, http: ["POST", `/api/tickets/${T}/relations`, { target_ticket_id: T, kind: "related" }], bus: ["ticket.relate", { id: T, target_ticket_id: T, kind: "related" }] },
    { name: "an agent editing a level", token: AGENT, http: ["POST", `/api/messages/${T}/edit`, { level: "milestone" }], bus: ["message.edit", { id: T, level: "milestone" }] },
    { name: "an agent stepping a comment", token: AGENT, http: ["POST", `/api/messages/${T}/step`], bus: ["message.step", { id: T }] },
    { name: "a move to the same project", token: HUMAN, http: ["POST", `/api/tickets/${T}/move`, { project: "p-served" }], bus: ["ticket.move", { id: T, project: "p-served" }] },
];

for (const k of cases) {
    test(`HTTP and the bus answer alike: ${k.name}`, async () => {
        const h = await http(k.token, k.http[0], k.http[1], k.http[2]);
        const b = await bus(k.token, k.bus[0], k.bus[1]);
        if (h.status < 300) {
            assert.ok(b.ok, `the bus refused what HTTP accepted: ${JSON.stringify(b)}`);
            let result = JSON.parse(JSON.stringify((b as { result: unknown }).result));
            // The inbox: HTTP sends the rows as the body and the total as X-Total-Count.
            if (k.bus[0] === "inbox.list") {
                assert.equal(result.total, Number(h.total));
                result = result.rows;
            }
            assert.deepEqual(stripVolatile(result), stripVolatile(h.json));
        } else {
            assert.ok(!b.ok, "the bus accepted what HTTP refused");
            const r = b as { status: number; code: string; message: string };
            assert.deepEqual([r.status, r.code, r.message], [h.status, h.json.code, h.json.error]);
        }
    });
}
