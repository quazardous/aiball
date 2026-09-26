/**
 * #3067 — the last calls of the shared client, as methods: rules, a message's
 * tag set, a consumer's record, the config, the step timing, the import and
 * the reload. Over the bus and over the routes that now serve them, the same
 * answers; the capability fields stay a human's, the reload stays local.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-admin-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { insertTag } = await import("../db/tags.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-adm" });
insertTag({ name: "adm-a" });
insertTag({ name: "adm-b" });
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

const status = (n: number) => (e: { status: number }) => e.status === n;

test("rules: create, list, toggle, delete; the route answers the same, a bad action is refused", async () => {
    const w = await as(WORKER);
    const rule = await w.call<{ id: number; enabled: boolean }>("automation.create_rule", {
        triggers: ["message_posted"], action: { kind: "decision", decision: "review" }, match_project: " p-adm ",
    });
    assert.equal((rule as unknown as { match_project: string }).match_project, "p-adm", "trimmed");
    const listed = await w.call<Array<{ id: number }>>("automation.rules", { trigger: "message_posted" });
    assert.ok(listed.some((r) => r.id === rule.id));
    assert.deepEqual(listed, (await http("GET", "/api/automation/rules?trigger=message_posted")).json);

    // The row stores the flag as 0 / 1, over both transports.
    assert.equal(Boolean((await w.call<{ enabled: unknown }>("automation.update_rule", { id: rule.id, enabled: false })).enabled), false);
    const viaRoute = await http("PATCH", `/api/automation/rules/${rule.id}`, { enabled: true });
    assert.equal(Boolean((viaRoute.json as { enabled: unknown }).enabled), true);

    await assert.rejects(w.call("automation.create_rule", { triggers: ["message_posted"], actions: [{ kind: "nope" }] }), status(400));
    await assert.rejects(w.call("automation.rules", { trigger: "whenever" }), status(400));
    await assert.rejects(w.call("automation.delete_rule", { id: -1 }), status(400));
    assert.equal((await http("DELETE", `/api/automation/rules/${rule.id}`)).status, 204);
    assert.ok(!(await w.call<Array<{ id: number }>>("automation.rules", {})).some((r) => r.id === rule.id));
});

test("a message's tag set is replaced; an unknown tag is refused, nothing changed", async () => {
    const w = await as(WORKER);
    const t = submitMessage({ project: "p-adm", kind: "ticket_created", title: "tags", body: "b", by_agent: "worker" });
    const tags = await w.call<Array<{ name: string }>>("message.set_tags", { id: t.id, tag_ids: ["adm-a", "adm-b"] });
    assert.deepEqual(tags.map((x) => x.name).sort(), ["adm-a", "adm-b"]);
    const viaRoute = await http("PUT", `/api/messages/${t.id}/tags`, { tag_ids: ["adm-b"] });
    assert.deepEqual((viaRoute.json as Array<{ name: string }>).map((x) => x.name), ["adm-b"]);
    await assert.rejects(w.call("message.set_tags", { id: t.id, tag_ids: ["ghost"] }), status(400));
    await assert.rejects(w.call("message.set_tags", { id: t.id, tag_ids: ["adm-a"], set_by: "boss" }), (e: { code: string }) => e.code === "AUTHOR_MISMATCH");
});

test("a consumer's record: anyone upserts and edits the note, only a human sets a capability", async () => {
    const w = await as(WORKER);
    const boss = await as(BOSS);
    await w.call("consumer.upsert", { consumer_id: "helper", kind: "agent", note: "kept" });
    await w.call("consumer.upsert", { consumer_id: "helper" });
    assert.equal(getConsumer("helper")?.note, "kept", "an absent field leaves the record alone");
    await assert.rejects(w.call("consumer.upsert", { consumer_id: "x", kind: "robot" }), status(400));

    assert.equal((await w.call<{ note: string }>("consumer.update", { consumer_id: "helper", note: "edited" })).note, "edited");
    await assert.rejects(w.call("consumer.update", { consumer_id: "helper", can_claim: false }), (e: { code: string }) => e.code === "MODERATOR_ONLY");
    const viaRoute = await http("PATCH", "/api/consumers/helper", { agent_type: "cto" });
    assert.equal(viaRoute.status, 403, "the route holds the same gate");
    assert.equal((await boss.call<{ agent_type: string }>("consumer.update", { consumer_id: "helper", agent_type: "cto" })).agent_type, "cto");
    await assert.rejects(boss.call("consumer.update", { consumer_id: "ghost", note: "n" }), (e: { code: string }) => e.code === "CONSUMER_NOT_FOUND");
});

test("config, step timing, import and reload", async () => {
    const w = await as(WORKER);
    assert.deepEqual(await w.call("config.get", {}), (await http("GET", "/api/config")).json);
    const timing = await w.call<{ project: string; since: string | null }>("step.timing", { project: "p-adm", since_days: 7 });
    assert.equal(timing.project, "p-adm");
    assert.ok(timing.since, "since_days becomes a cutoff");

    await assert.rejects(w.call("ticket.import", { project: "p-adm" }), status(400));
    await assert.rejects(w.call("ticket.import", { ref: "gh#1" }), status(400));

    // Over TCP: a remote caller, whoever it is, cannot reload.
    const boss = await as(BOSS);
    await assert.rejects(boss.call("daemon.reload", {}), status(403));
    assert.equal((await http("POST", "/api/daemon/reload", {}, BOSS)).status, 403);
});
