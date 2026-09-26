/**
 * #3052 — tvty's contract, tested on aiball's side. tvty is Rust: it cannot
 * share `client.ts`, so a change here that would break it has to fail here.
 *
 * The calls below are tvty's, as it sends them (tvty `src/aiball.rs`, at
 * 95661cf): over the local socket, as the human, with the exact bodies. The
 * fields are the ones its serde structs read. Most of them are `Option` or
 * `#[serde(default)]` on tvty's side, so a field dropped here would not make
 * tvty fail — it would silently lose a feature. So every field tvty reads must
 * be present, with its type when it is not null.
 *
 * When tvty changes what it calls or reads, this table changes with it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3052-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachWs } = await import("../ws.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, insertUpload } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { insertTag } = await import("../db/tags.js");
const { UPLOADS_DIR } = await import("../paths.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

// ── the board tvty looks at ──────────────────────────────────────────────
const P = "p-3052";
const HUMAN = "david";
upsertConsumer({ consumer_id: HUMAN, kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3052-w" }).token;
createProject({ name: P });
createProject({ name: `${P}-b` });
upsertSubscription("worker", P, "owner");
insertTag({ name: "front", color: "#00f" });

mkdirSync(UPLOADS_DIR, { recursive: true });
const png = Buffer.from("a picture");
const sha = createHash("sha256").update(png).digest("hex");
writeFileSync(join(UPLOADS_DIR, `${sha}.png`), png);
insertUpload({ sha, ext: "png", content_type: "image/png", bytes: png.length, original_name: "shot.png" });

const ticketOf = (title: string, by = HUMAN) => submitMessage({ project: P, kind: "ticket_created", title, body: "b", by_agent: by }).id;
const milestone = ticketOf("v1");
getDb().update(schema.tickets).set({ level: "milestone" }).where(eq(schema.tickets.id, milestone)).run();
const main = ticketOf("the thread tvty opens");
const other = ticketOf("another");
const plan = submitMessage({ project: P, kind: "comment_added", ticket_id: main, body: `a plan ![](/uploads/${sha}.png)\n- [ ] <!-- q:qq1 --> which db?`, by_agent: "worker", decision_kind: "plan", summary_until: "s" }).id;

// ── the transport: the local socket, the human by header, like the daemon ─
const SOCK = join(process.env.AIBALL_HOME!, "sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
attachWs(uds, "/ws", { trusted: true });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));
const tcp = createApp().listen(0);
await new Promise<void>((r) => tcp.once("listening", () => r()));
const TCP = `http://127.0.0.1:${(tcp.address() as AddressInfo).port}`;
after(() => {
    uds.close();
    tcp.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const req = httpRequest({
            socketPath: SOCK, path, method,
            headers: { "x-aiball-consumer": HUMAN, ...(payload && !headers["content-type"] ? { "content-type": "application/json" } : {}), ...headers },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json: unknown = text;
                try { json = JSON.parse(text); } catch { /* raw body */ }
                resolve({ status: res.statusCode ?? 0, json });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── shapes: every key present; "?" = may be null; nested objects checked when not null ─
type Shape = string | { [k: string]: Shape } | [Shape];
function problems(value: unknown, shape: Shape, at: string): string[] {
    if (typeof shape === "string") {
        const nullable = shape.endsWith("?");
        const type = nullable ? shape.slice(0, -1) : shape;
        if (value === null || value === undefined) return nullable ? [] : [`${at}: null`];
        if (type === "any") return [];
        const actual = Array.isArray(value) ? "array" : typeof value;
        return actual === type ? [] : [`${at}: ${actual}, not ${type}`];
    }
    if (Array.isArray(shape)) {
        if (!Array.isArray(value)) return [`${at}: not an array`];
        return value.flatMap((v, i) => problems(v, shape[0], `${at}[${i}]`));
    }
    if (value === null || value === undefined) return [];
    if (typeof value !== "object") return [`${at}: not an object`];
    return Object.entries(shape).flatMap(([k, s]) => (k in (value as object)
        ? problems((value as Record<string, unknown>)[k], s, `${at}.${k}`)
        : [`${at}.${k}: missing`]));
}

const TAG: Shape = { name: "string", color: "string?" };
const HOLDING = { holder: "string?", held_as: "string?" };
const TOKEN_USAGE: Shape = { tokens_in: "number", tokens_out: "number", cache_w: "number", cache_r: "number" };
const CONSUMER: Shape = {
    consumer_id: "string", kind: "string", cwd: "string?", project: "string?", last_seen_at: "string?",
    state: "string?", state_since: "string?", state_human_word: "string?", present: "boolean?",
    ping_unseen: "number?", wait_credit: "array?",
};
const ROW: Shape = {
    id: "number", project: "string", title: "string", status: "string", closed: "boolean", resolved: "boolean",
    priority: "string?", claimant: "string?", assignee: "string?", ...HOLDING, unread: "boolean", hot: "boolean",
    last_speaker: "string?", last_activity: "string?", comment_count: "number", critical: "object?",
    pending_plan: "boolean", pending_resolution: "boolean", pending_wontfix: "boolean", pending_escalation: "boolean",
    pending_comment_count: "number", pending_decision_is_latest: "boolean", latest_is_step: "boolean",
    stalled_step: "boolean", latest_plan_rejected: "boolean", latest_resolution_rejected: "boolean",
    turn: "string", band: "number", state_glyph: "string?", snippet: "string?", by_agent: "string",
    created_at: "string", intent: "string?", level: "string?", scope: "string?", blocked: "boolean",
    milestone: { title: "string?" }, tags: [TAG], token_usage: TOKEN_USAGE, postponed_until: "string?",
    has_payload: "boolean",
};
const THREAD: Shape = {
    ticket: {
        id: "number", title: "string", body: "string?", by_agent: "string", created_at: "string", status: "string",
        closed: "boolean", resolved: "boolean", resolved_by: "string?", priority: "string?", claimant: "string?",
        assignee: "string?", ...HOLDING, step: { resume_at: "string?", resume_on_ticket: "number?" },
        critical: "object?", token_usage: TOKEN_USAGE, meta: "string?", postponed_until: "string?",
        relations: [{ target_ticket_id: "number", kind: "string", target_stage: "string?" }],
        intent: "string?", level: "string?", scope: "string?", tags: [TAG], milestone: { title: "string?" },
        claim_until: "string?", parent_ticket_id: "number?", sub_tickets: "array", has_payload: "boolean",
    },
    comments: [{
        id: "number", kind: "string", by_agent: "string", body: "string?", meta: "string?", created_at: "string",
        status: "string", source_ticket_id: "number?", hashid: "string?",
        votes_summary: { up: "number", down: "number", mine: "number?" },
    }],
    attachments: [{ ref: "string", content_type: "string?", bytes: "number?", uri: "string?", local: "boolean" }],
};
const BAR: Shape = {
    bar: {
        phase: "string", presence: "string", afk: { mode: "string", expires_at: "string?" },
        prompt: { visible: "boolean", has_input: "boolean" }, human_typing: "boolean",
        marker: { info: "string?", health_prompt: "boolean", resume_picker: "boolean", resume_mode_picker: "boolean" },
        alerts: { link_down: "boolean", daemon_down: "boolean", not_logged_in: "boolean", trust_dialog: "boolean", api_unreachable: "boolean" },
        proxy_alive: "boolean", zen: "boolean",
        counters: { open: "number?", backlog: "number?", events: "number?" },
        next_wake_at: "string?", boot: { started_at: "string", deadline_at: "string?" },
    },
    stale: "boolean",
};

test("reads: every field tvty reads is there, with its type", async () => {
    // A bar pushed by the agent's loop, so tvty has one to read.
    const bar = {
        phase: "idle", presence: "loop", afk: { mode: "off", expires_at: null }, prompt: { visible: true, has_input: false },
        human_typing: false, marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
        alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false },
        proxy_alive: true, zen: false, counters: { open: 1, backlog: 0, events: 0 }, next_wake_at: null, boot: null,
    };
    const pushed = await fetch(`${TCP}/api/consumers/worker/bar`, { method: "PUT", headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json" }, body: JSON.stringify(bar) });
    assert.equal(pushed.status, 200);

    const reads: [string, Shape][] = [
        ["/api/consumers", [CONSUMER]],
        [`/api/inbox?project=${P}&open=1&view=turn&sort=band`, [ROW]],
        [`/api/inbox?project=${P}&view=turn&sort=band&limit=50`, [ROW]],
        [`/api/tickets/${main}?full=1&limit=9999`, THREAD],
        [`/api/messages/${plan}`, { kind: "string", by_agent: "string", project: "string", title: "string?", meta: "string?" }],
        ["/api/consumers/worker/bar", BAR],
        [`/api/consumers/worker/backlog?project=${P}`, { rows: [{ id: "number", project: "string", title: "string", backlog_tier: "number?" }] }],
        [`/api/tags?project=${P}`, [TAG]],
        [`/api/projects/${P}/milestones`, { milestones: [{ id: "number", title: "string?", released: "boolean?" }] }],
        ["/api/mention-suggestions", { projects: ["string"], agents: ["string"] }],
    ];
    for (const [path, shape] of reads) {
        const r = await call("GET", path);
        assert.equal(r.status, 200, `GET ${path} → ${r.status} ${JSON.stringify(r.json)}`);
        assert.deepEqual(problems(r.json, shape, `GET ${path}`), []);
    }
    // The data it needs to be non-empty for the checks above to mean something.
    const thread = (await call("GET", `/api/tickets/${main}?full=1&limit=9999`)).json as { comments: unknown[]; attachments: unknown[] };
    assert.ok(thread.comments.length > 0 && thread.attachments.length > 0, "the thread has comments and an attachment");
    assert.ok(((await call("GET", `/api/inbox?project=${P}&view=turn&sort=band&limit=50`)).json as unknown[]).length > 0);
});

test("reads: an image by its API path, derived from the cited form", async () => {
    const r = await call("GET", `/api/uploads/${sha}`);
    assert.equal(r.status, 200);
});

test("reads: /ws over the socket announces a change with its type and project", async () => {
    const ws = new WebSocket(`ws+unix://${SOCK}:/ws`, { headers: { "x-aiball-consumer": HUMAN } });
    await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
    const got = new Promise<{ type: string; data: { project?: string } }>((r) => ws.on("message", (m) => {
        const e = JSON.parse(String(m)) as { type: string; data: { project?: string } };
        if (e.data?.project === P) r(e);
    }));
    await call("POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: other, parent_id: other, body: "ping" });
    const e = await got;
    assert.equal(typeof e.type, "string");
    ws.close();
});

test("writes: every body tvty sends is accepted", async () => {
    const r1 = await call("POST", "/api/messages", {
        project: P, kind: "ticket_created", title: "filed whole", body: "b", intent: "request",
        summary: "s", priority: "high", scope: "internal", parent_id: main, tags: ["front"],
        assignee: "worker", milestone, level: "task",
    }, { "x-aiball-platform": "linux" });
    assert.equal(r1.status, 201, JSON.stringify(r1.json));
    const filed = (r1.json as { id: number }).id;
    const comment = await call("POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: main, parent_id: main, body: "a reply" });
    assert.equal(comment.status, 201, JSON.stringify(comment.json));
    const mine = (comment.json as { id: number }).id;
    const quiet = await call("POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: main, parent_id: main, body: "quiet", scope: "internal" });
    assert.equal(quiet.status, 201);
    const quietId = (quiet.json as { id: number }).id;
    const pending = ticketOf("an agent's, awaiting moderation", "worker");
    const pending2 = ticketOf("another awaiting moderation", "worker");
    const step = submitMessage({ project: P, kind: "comment_added", ticket_id: main, body: "working", by_agent: "worker", summary_until: "s", handback: true }).id;

    const writes: [string, string, unknown, number][] = [
        ["POST", `/api/tickets/${main}/mark-read`, {}, 200],
        ["POST", `/api/agents/worker/afk`, { action: "toggle" }, 404], // no loop on this test board: the route answers LOOP_NOT_FOUND
        ["POST", `/api/messages/${plan}/questions/qq1/answer`, { answered_in: mine }, 200],
        ["POST", `/api/tickets/${other}/postpone`, { until: new Date(Date.now() + 86_400_000).toISOString() }, 200],
        ["POST", `/api/tickets/${other}/unsnooze`, {}, 200],
        ["POST", `/api/messages/${other}/edit`, { priority: "high" }, 200],
        ["POST", `/api/messages/${other}/edit`, { title: "renamed" }, 200],
        ["POST", `/api/messages/${other}/edit`, { intent: "question" }, 200],
        ["POST", `/api/messages/${other}/edit`, { level: "task" }, 200],
        ["POST", `/api/messages/${other}/edit`, { scope: "default" }, 200],
        ["POST", `/api/messages/${other}/edit`, { body: "new body" }, 200],
        ["POST", `/api/messages/${other}/tags`, { tag: "front" }, 201],
        ["DELETE", `/api/messages/${other}/tags/front`, undefined, 200],
        ["POST", `/api/tickets/${other}/milestone`, { milestone_id: milestone }, 200],
        ["POST", `/api/tickets/${other}/milestone`, { milestone_id: null }, 200],
        ["POST", `/api/tickets/${other}/assign`, { assignee: "worker" }, 200],
        ["POST", `/api/tickets/${other}/release`, {}, 200],
        ["POST", `/api/tickets/${other}/owner`, { by_agent: "worker" }, 200],
        ["POST", `/api/tickets/${other}/relations`, { target_ticket_id: main, kind: "relates_to" }, 200],
        ["POST", `/api/tickets/${other}/relations`, { target_ticket_id: main, kind: "ignored" }, 200],
        ["POST", `/api/messages/${step}/step`, {}, 200],
        ["POST", `/api/messages/${step}/unstep`, {}, 200],
        ["POST", `/api/messages/${mine}/promote`, { kind: "plan" }, 200],
        ["POST", `/api/messages/${mine}/untag`, {}, 200],
        ["POST", `/api/messages/${plan}/vote`, { value: 1 }, 200],
        ["POST", `/api/messages/${plan}/vote`, { value: 0 }, 200],
        ["POST", `/api/messages/${mine}/resurface`, {}, 200],
        ["POST", `/api/messages/${plan}/decide`, { status: "accepted" }, 200],
        ["POST", `/api/messages/${pending}/approve`, {}, 200],
        ["POST", `/api/messages/${pending2}/reject`, {}, 200],
        ["POST", `/api/messages/${quietId}/delete`, {}, 200],
        ["POST", "/api/messages", { project: P, kind: "ticket_closed", ticket_id: other, parent_id: other }, 201],
        ["POST", "/api/messages", { project: P, kind: "ticket_reopened", ticket_id: other, parent_id: other }, 201],
        ["POST", `/api/tickets/${filed}/move`, { project: `${P}-b` }, 200],
    ];
    for (const [method, path, body, status] of writes) {
        const r = await call(method, path, body).catch((e) => { throw new Error(`${method} ${JSON.stringify(path)}: ${(e as Error).message}`); });
        assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.json)}`);
    }
    const upload = await call("POST", "/api/uploads", Buffer.from("another picture"), { "content-type": "image/png", "x-aiball-upload-name": "b.png" });
    assert.ok(upload.status < 300, JSON.stringify(upload.json));
    assert.equal(typeof (upload.json as { url?: unknown }).url, "string", "tvty reads the upload's url");
});

test("refusals carry a code tvty can branch on", async () => {
    const r = await call("GET", "/api/messages/987654321");
    assert.deepEqual([r.status, (r.json as { code?: string }).code], [404, "MESSAGE_NOT_FOUND"]);
});

/** The routes the tests above exercise, as `docs/API-ROUTES.md` names them. */
const COVERED = new Set([
    "GET /api/consumers", "GET /api/inbox", "GET /api/tickets/:id", "GET /api/messages/:id",
    "GET /api/consumers/:consumer_id/bar", "GET /api/consumers/:consumer_id/backlog", "GET /api/tags",
    "GET /api/projects/:project/milestones", "GET /api/mention-suggestions",
    "POST /api/messages", "POST /api/tickets/:id/mark-read", "POST /api/agents/:name/afk",
    "POST /api/messages/:id/questions/:qid/answer", "POST /api/tickets/:id/postpone", "POST /api/tickets/:id/unsnooze",
    "POST /api/messages/:id/edit", "POST /api/messages/:id/tags", "DELETE /api/messages/:id/tags/:tag",
    "POST /api/tickets/:id/milestone", "POST /api/tickets/:id/assign", "POST /api/tickets/:id/release",
    "POST /api/tickets/:id/owner", "POST /api/tickets/:id/relations", "POST /api/messages/:id/step",
    "POST /api/messages/:id/unstep", "POST /api/messages/:id/promote", "POST /api/messages/:id/untag",
    "POST /api/messages/:id/vote", "POST /api/messages/:id/resurface", "POST /api/messages/:id/decide",
    "POST /api/messages/:id/approve", "POST /api/messages/:id/reject", "POST /api/messages/:id/delete",
    "POST /api/tickets/:id/move", "POST /api/uploads",
]);

test("every route the inventory says tvty calls (●) is covered here", () => {
    const table = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/API-ROUTES.md"), "utf8");
    const header = table.split("\n").find((l) => l.startsWith("| Route |"))!.split("|").map((c) => c.trim());
    const col = header.indexOf("tvty");
    const tvty = table.split("\n")
        .filter((l) => l.startsWith("| `"))
        .map((l) => l.split("|"))
        .filter((cells) => cells[col]!.trim() === "●")
        .map((cells) => cells[1]!.trim().replace(/`/g, ""));
    assert.ok(tvty.length > 20, "the tvty column was read");
    assert.deepEqual(tvty.filter((r) => !COVERED.has(r)), [], "tvty calls these and no test here covers them");
});
