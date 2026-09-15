/**
 * #2526 — API keys with scopes, and tickets created by a key.
 *
 * What must hold, over HTTP and over a Unix socket tagged like the daemon's:
 * - a key minted before scopes existed keeps exactly `signals`;
 * - each door needs its scope: `signals` cannot create tickets, `tickets:create`
 *   cannot post signals, and neither opens any other route;
 * - `tickets:create` needs projects, and creates only in them;
 * - the ticket is approved at once, authored by the key's source, fanned out;
 * - `external_id` replayed returns the ticket already created;
 * - an agent or a human cannot use the route.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2526-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { insertTag } = await import("../db/tags.js");
const schema = await import("../schema.js");
const { and, eq, isNull } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
createProject({ name: "shop" });
createProject({ name: "other" });
upsertSubscription("lead", "shop", "owner");
insertTag({ name: "from-ci" });
const LEGACY = issueToken({ kind: "signal", label: "legacy-src" }).token; // minted before scopes: NULL
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2526-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "lead", label: "2526-a" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const sockDir = mkdtempSync("/tmp/ab-keytk-");
const SOCK = join(sockDir, "t.sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));
after(() => {
    server.close();
    uds.close();
    for (const d of [process.env.AIBALL_HOME!, sockDir]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Res = { status: number; json: any };
async function http(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}
function sock(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = httpRequest({
            socketPath: SOCK, path: `/api${path}`, method,
            headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)), ...headers },
        }, (res) => {
            let buf = ""; res.on("data", (c) => { buf += c; });
            res.on("end", () => { let json: any; try { json = JSON.parse(buf); } catch { json = buf; } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.on("error", reject); req.write(data); req.end();
    });
}
async function mint(label: string, scopes?: string[], projects?: string[]): Promise<Res> {
    return http("POST", "/signal-keys", { label, note: "test", ...(scopes ? { scopes } : {}), ...(projects ? { projects } : {}) }, HUMAN);
}
const signal = { target: { consumer: "lead" }, title: "hello" };

test("scopes are validated when a key is minted, and an old key keeps exactly `signals`", async () => {
    assert.equal((await mint("bad-scope", ["tickets:delete"])).status, 400);
    assert.match((await mint("no-proj", ["tickets:create"])).json.error, /needs at least one project/);
    assert.match((await mint("ghost-proj", ["tickets:create"], ["nope"])).json.error, /no such project: nope/);
    const plain = await mint("plain");
    assert.deepEqual(plain.json.key.scopes, ["signals"], "no scopes given = signals, as before");

    const keys = (await http("GET", "/signal-keys", undefined, HUMAN)).json as { label: string; scopes: string[] }[];
    assert.deepEqual(keys.find((k) => k.label === "legacy-src")?.scopes, ["signals"]);
    assert.equal((await http("POST", "/signals", signal, LEGACY)).status, 200);
    assert.match((await http("POST", "/tickets", { project: "shop", title: "t" }, LEGACY)).json.error, /lacks the scope tickets:create/);
});

test("each door needs its scope, over HTTP and on the socket; no key opens anything else", async () => {
    const tk = (await mint("ci", ["tickets:create"], ["shop"])).json.token as string;
    assert.equal((await http("POST", "/signals", signal, tk)).status, 403, "tickets:create cannot post signals");
    assert.equal((await sock("POST", "/signals", signal, { authorization: `Bearer ${tk}` })).status, 403, "…on the socket either");
    assert.equal((await http("GET", "/tickets", undefined, tk)).status, 403, "nor read tickets");
    assert.equal((await http("POST", "/messages", { project: "shop", kind: "ticket_created", title: "x" }, tk)).status, 403);
});

test("a key creates an approved ticket in its projects only, authored by its source, and the owners hear it", async () => {
    const tk = (await mint("github-bridge", ["tickets:create", "signals"], ["shop"])).json.token as string;
    assert.match((await http("POST", "/tickets", { project: "other", title: "t" }, tk)).json.error, /may not create tickets in other/);
    assert.match((await http("POST", "/tickets", { project: "shop", title: "t", tags: ["nope"] }, tk)).json.error, /unknown tag nope/);

    const r = await http("POST", "/tickets", { project: "shop", title: "build broke on main", body: "see run 42", priority: "high", tags: ["from-ci"], by_agent: "spoofed" }, tk);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.status, "approved");
    assert.equal(r.json.by_agent, "github-bridge", "the source is the key's, never the body's");
    assert.equal(r.json.priority, "high");
    assert.deepEqual(r.json.tags.map((t: { name: string }) => t.name), ["from-ci"]);
    const pinged = getDb().select().from(schema.pings)
        .where(and(eq(schema.pings.recipient, "lead"), eq(schema.pings.ticketId, r.json.id), isNull(schema.pings.seenAt))).all();
    assert.equal(pinged.length, 1, "the project owner got the ticket");

    const onSock = await sock("POST", "/tickets", { project: "shop", title: "from the socket" }, { authorization: `Bearer ${tk}` });
    assert.equal(onSock.status, 201);
    assert.equal(onSock.json.by_agent, "github-bridge");
});

test("external_id makes a retry return the ticket already created", async () => {
    const tk = (await mint("retrying", ["tickets:create"], ["shop"])).json.token as string;
    const first = await http("POST", "/tickets", { project: "shop", title: "once", external_id: "run-42" }, tk);
    assert.equal(first.status, 201);
    const again = await http("POST", "/tickets", { project: "shop", title: "once, again", external_id: "run-42" }, tk);
    assert.equal(again.status, 200);
    assert.equal(again.json.id, first.json.id);
    assert.equal(again.json.existing, true);
    const other = await http("POST", "/tickets", { project: "shop", title: "another run", external_id: "run-43" }, tk);
    assert.notEqual(other.json.id, first.json.id);
});

test("agents and humans cannot use the route, and the socket still wants a key", async () => {
    assert.equal((await http("POST", "/tickets", { project: "shop", title: "t" }, AGENT)).status, 403);
    assert.equal((await http("POST", "/tickets", { project: "shop", title: "t" }, HUMAN)).status, 403);
    assert.equal((await sock("POST", "/tickets", { project: "shop", title: "t" })).status, 403);
});

test("a key's scopes and projects can be edited, and the change applies at once", async () => {
    const minted = (await mint("editable")).json as { key: { key_id: string }; token: string };
    assert.equal((await http("POST", "/tickets", { project: "shop", title: "t" }, minted.token)).status, 403);
    const up = await http("PATCH", `/signal-keys/${minted.key.key_id}`, { scopes: ["signals", "tickets:create"], projects: ["shop"] }, HUMAN);
    assert.deepEqual(up.json.scopes, ["signals", "tickets:create"]);
    assert.equal((await http("POST", "/tickets", { project: "shop", title: "t" }, minted.token)).status, 201);
});

test("assignee: a consumer of the project gets the ticket, is subscribed and pinged; anyone else is refused", async () => {
    upsertConsumer({ consumer_id: "crewbee", kind: "agent" });
    upsertSubscription("crewbee", "shop", "follower");
    upsertConsumer({ consumer_id: "stranger", kind: "agent" });
    const tk = (await mint("assigning", ["tickets:create"], ["shop"])).json.token as string;

    const refused = await http("POST", "/tickets", { project: "shop", title: "t", assignee: "stranger" }, tk);
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /stranger is not subscribed to shop/);

    const r = await http("POST", "/tickets", { project: "shop", title: "for the crew", assignee: "crewbee" }, tk);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.assignee, "crewbee");
    assert.equal(r.json.assigned_by, "assigning");
    const pinged = getDb().select().from(schema.pings)
        .where(and(eq(schema.pings.recipient, "crewbee"), eq(schema.pings.ticketId, r.json.id))).all();
    assert.equal(pinged.length, 1, "a follower assignee is pinged, the creation fan-out alone would not have");
    const subs = getDb().select().from(schema.ticketSubscriptions)
        .where(and(eq(schema.ticketSubscriptions.consumerId, "crewbee"), eq(schema.ticketSubscriptions.ticketId, r.json.id))).all();
    assert.equal(subs.length, 1);
});
