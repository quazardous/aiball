/**
 * #3067 — the payload zone and the pending children as methods: bus and route
 * agree, and a dump refused on a revoked payload says so in `details.access`
 * over HTTP as on the bus.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-misc-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
createProject({ name: "p-misc" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;
const OTHER = issueToken({ kind: "agent", consumer_id: "other", label: "o" }).token;

const tcp = createServer(createApp());
const wss = attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as { port: number }).port;
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    tcp.closeAllConnections();
    tcp.close();
    rmSync(home, { recursive: true, force: true });
});

async function as(token: string) {
    const c = await BusClient.connect({ url: `http://127.0.0.1:${port}`, token });
    clients.push(c);
    return c;
}
function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json" } }, (res) => {
            let b = "";
            res.on("data", (d) => { b += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : {} }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

test("the payload: deposit, read, dump, revoke; a revoked dump says why, over HTTP as on the bus", async () => {
    const w = await as(WORKER);
    const t = submitMessage({ project: "p-misc", kind: "ticket_created", title: "vault", body: "b", by_agent: "worker" });
    await w.call("ticket.set_payload", { id: t.id, payload: { token: "s3cret", host: "db" }, schema: ["host"] });
    assert.deepEqual(await w.call("ticket.payload", { id: t.id }), (await http("GET", `/api/tickets/${t.id}/payload`)).json);
    assert.deepEqual((await w.call<{ payload: Record<string, string> }>("ticket.dump_payload", { id: t.id })).payload, { token: "s3cret", host: "db" });
    const o = await as(OTHER);
    await assert.rejects(o.call("ticket.dump_payload", { id: t.id }), (e: { status: number }) => e.status === 403, "neither reporter nor assignee");
    await w.call("ticket.revoke_payload", { id: t.id });
    await assert.rejects(w.call("ticket.dump_payload", { id: t.id }), (e: { status: number; details: { access: string } }) => e.status === 410 && e.details.access === "revoked");
    const viaHttp = await http("POST", `/api/tickets/${t.id}/payload/dump`, {});
    assert.equal(viaHttp.status, 410);
    assert.equal((viaHttp.json.details as { access: string }).access, "revoked");
});

test("pending children: bus and route agree; approving them is a human's", async () => {
    const w = await as(WORKER);
    const t = submitMessage({ project: "p-misc", kind: "ticket_created", title: "parent", body: "b", by_agent: "worker" });
    assert.deepEqual(await w.call("ticket.pending_children", { id: t.id }), (await http("GET", `/api/tickets/${t.id}/pending-children`)).json);
    await assert.rejects(w.call("ticket.approve_pending_children", { id: t.id, ticket_ids: [1] }), (e: { code: string }) => e.code === "MODERATOR_ONLY");
});
