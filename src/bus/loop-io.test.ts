/**
 * #3067 — what a loop calls all the time, as methods: over the bus and over
 * the routes that now serve them, the same answers; state and bar pushes are
 * one's own and an agent's only; the bar route still takes the bar as its
 * whole body.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-loopio-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { getAgentBar } = await import("../agent-bar-store.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
createProject({ name: "p-io" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;
const BOSS = issueToken({ kind: "auth", consumer_id: "boss", label: "b" }).token;

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

function http(method: string, path: string, body?: unknown, token = WORKER): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
            let b = "";
            res.on("data", (d) => { b += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : null }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

const BAR = {
    phase: "idle", presence: "loop", afk: { mode: "off", expires_at: null },
    prompt: { visible: true, has_input: false }, human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false },
    proxy_alive: true, zen: false, counters: null, next_wake_at: null, boot: null,
};

test("state and bar: one's own, an agent's; the bar route takes the bar as its body", async () => {
    const w = await as(WORKER);
    const st = await w.call<{ consumer_id: string; state: string }>("consumer.push_state", { consumer_id: "worker", state: "busy", human_word: "loop" });
    assert.deepEqual([st.consumer_id, st.state], ["worker", "busy"]);
    await assert.rejects(w.call("consumer.push_state", { consumer_id: "other", state: "idle" }), (e: { status: number }) => e.status === 403);
    await assert.rejects(w.call("consumer.push_state", { consumer_id: "worker", state: "asleep" }), (e: { status: number }) => e.status === 400);
    const boss = await as(BOSS);
    await assert.rejects(boss.call("consumer.push_state", { consumer_id: "boss", state: "idle" }), (e: { status: number }) => e.status === 403);

    assert.equal((await w.call<{ changed: boolean }>("consumer.push_bar", { consumer_id: "worker", bar: BAR })).changed, true);
    assert.equal(getAgentBar("worker")?.bar.phase, "idle");
    const viaRoute = await http("PUT", "/api/consumers/worker/bar", { ...BAR, phase: "busy" });
    assert.equal(viaRoute.status, 200, JSON.stringify(viaRoute.json));
    assert.equal(getAgentBar("worker")?.bar.phase, "busy", "the route took the body as the bar");
    await assert.rejects(w.call("consumer.push_bar", { consumer_id: "other", bar: BAR }), (e: { status: number }) => e.status === 403);
    await assert.rejects(w.call("consumer.push_bar", { consumer_id: "worker", bar: { phase: "nope" } }), (e: { status: number }) => e.status === 400);

    // last_seen_at moves with every request: the rest is the same.
    const seenless = (c: unknown) => ({ ...(c as Record<string, unknown>), last_seen_at: null });
    assert.deepEqual(seenless(await w.call("consumer.get", { consumer_id: "worker" })), seenless((await http("GET", "/api/consumers/worker")).json));
    await assert.rejects(w.call("consumer.get", { consumer_id: "ghost" }), (e: { code: string }) => e.code === "CONSUMER_NOT_FOUND");
});

test("token usage, the message list and the bookends: bus and route agree", async () => {
    const w = await as(WORKER);
    const t = submitMessage({ project: "p-io", kind: "ticket_created", title: "io", body: "the body", by_agent: "worker" });
    const used = await w.call<{ ticket_id: number; ok: boolean }>("ticket.add_token_usage", { id: t.id, in: 10, out: 5 });
    assert.deepEqual([used.ticket_id, used.ok], [t.id, true]);
    await assert.rejects(w.call("ticket.add_token_usage", { id: 999_999, in: 1 }), (e: { code: string }) => e.code === "TICKET_NOT_FOUND");

    const q = "project=p-io&kind=ticket_created&summary=1";
    const viaBus = await w.call<Record<string, unknown>[]>("message.list", { project: "p-io", kind: "ticket_created", summary: true });
    assert.deepEqual(viaBus, (await http("GET", `/api/messages?${q}`)).json);
    assert.equal(viaBus[0]?.body, undefined, "summary drops the bodies");
    assert.deepEqual(await w.call("ticket.bookends", { project: "p-io" }), (await http("GET", "/api/tickets/bookends?project=p-io")).json);
});
