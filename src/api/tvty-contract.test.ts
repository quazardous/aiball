/**
 * #3052 — tvty's contract, tested on aiball's side. tvty is Rust: it cannot
 * share `client.ts`, so a change here that would break it has to fail here.
 *
 * The calls below are tvty's, as it sends them (tvty `src/aiball.rs`, at
 * d08fb90): on the bus, over the local socket, as the human, with the exact
 * methods and params; its uploads stay HTTP, over the same socket. The fields
 * are the ones its serde structs read. Most of them are `Option` or
 * `#[serde(default)]` on tvty's side, so a field dropped here would not make
 * tvty fail — it would silently lose a feature. So every field tvty reads must
 * be present, with its type when it is not null.
 *
 * When tvty changes what it calls or reads, this table changes with it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { matchCalls, readServerRoutes, tvtyBusMethods, tvtyCalls } from "../devtools/route-inventory-lib.js";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3052-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { authenticate } = await import("../auth.js");
const { callerOf, callMethod, methodNames, Refusal } = await import("../bus/methods.js");
const { asToken } = await import("../tests/bus-call.js");
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
// tvty's bus connection opens on the local socket with `x-aiball-consumer`
// (and `x-aiball-platform`): the caller is settled from those headers as the
// bus settles it there, then each call goes through the bus's own checks.
async function bus(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const all: Record<string, string> = { "x-aiball-consumer": HUMAN, ...headers };
    const out = authenticate({ transport: "uds", token: null, ip: null, header: (name) => all[name.toLowerCase()] });
    if (!out.ok) return { status: out.status, json: { error: out.error, code: out.code } };
    try {
        const result = await callMethod(callerOf(out.ctx), method, params);
        return { status: 200, json: result === undefined ? null : result };
    } catch (e) {
        if (e instanceof Refusal) return { status: e.status, json: { error: e.message, code: e.code } };
        throw e;
    }
}

// Uploads stay HTTP: the production app on a local socket.
const SOCK = join(process.env.AIBALL_HOME!, "sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));
after(() => {
    uds.close();
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
// tvty `ConfigEntry`: the fields without a serde default, and `sources`, which says what `config.set` may write.
const CONFIG_ENTRY: Shape = { key: "string", scope: "string", type: "string", label: "string", sources: ["string"] };
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
        host: "string?",
    },
    stale: "boolean",
};

test("reads: every field tvty reads is there, with its type", async () => {
    // A bar pushed by the agent's loop, so tvty has one to read.
    const bar = {
        phase: "idle", presence: "loop", afk: { mode: "off", expires_at: null }, prompt: { visible: true, has_input: false },
        human_typing: false, marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
        alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false, restart_needed: false },
        proxy_alive: true, zen: false, counters: { open: 1, backlog: 0, events: 0 }, next_wake_at: null, boot: null,
    };
    const pushed = await asToken(WORKER, "consumer.push_bar", { consumer_id: "worker", bar });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.json));

    const INBOX: Shape = { total: "number", rows: [ROW] };
    const reads: [string, Record<string, unknown>, Shape][] = [
        ["consumer.list", {}, [CONSUMER]],
        ["inbox.list", { project: P, open: true, view: "turn", sort: "band" }, INBOX],
        ["inbox.list", { project: P, view: "turn", sort: "band", limit: 50 }, INBOX],
        ["ticket.get", { id: main, full: true, limit: 9999 }, THREAD],
        ["message.get", { id: plan }, { kind: "string", by_agent: "string", project: "string", title: "string?", meta: "string?" }],
        ["consumer.bar", { consumer_id: "worker" }, BAR],
        ["consumer.backlog", { consumer_id: "worker", project: P }, { rows: [{ id: "number", project: "string", title: "string", backlog_tier: "number?" }] }],
        ["tag.list", { project: P }, [TAG]],
        ["project.milestones", { project: P }, { milestones: [{ id: "number", title: "string?", released: "boolean?" }] }],
        ["mention.suggestions", {}, { projects: ["string"], agents: ["string"] }],
    ];
    for (const [method, params, shape] of reads) {
        const r = await bus(method, params);
        const at = `${method} ${JSON.stringify(params)}`;
        assert.equal(r.status, 200, `${at} → ${r.status} ${JSON.stringify(r.json)}`);
        assert.deepEqual(problems(r.json, shape, at), []);
    }
    // The data it needs to be non-empty for the checks above to mean something.
    const thread = (await bus("ticket.get", { id: main, full: true, limit: 9999 })).json as { comments: unknown[]; attachments: unknown[] };
    assert.ok(thread.comments.length > 0 && thread.attachments.length > 0, "the thread has comments and an attachment");
    assert.ok(((await bus("inbox.list", { project: P, view: "turn", sort: "band", limit: 50 })).json as { rows: unknown[] }).rows.length > 0);
});

test("reads: an image by its API path, derived from the cited form", async () => {
    const r = await call("GET", `/api/uploads/${sha}`);
    assert.equal(r.status, 200);
});

test("writes: every body tvty sends is accepted", async () => {
    const r1 = await bus("message.post", {
        project: P, kind: "ticket_created", title: "filed whole", body: "b", intent: "request",
        summary: "s", priority: "high", scope: "internal", parent_id: main, tags: ["front"],
        assignee: "worker", milestone, level: "task",
    }, { "x-aiball-platform": "linux" });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const filed = (r1.json as { id: number }).id;
    const comment = await bus("message.post", { project: P, kind: "comment_added", ticket_id: main, parent_id: main, body: "a reply" });
    assert.equal(comment.status, 200, JSON.stringify(comment.json));
    const mine = (comment.json as { id: number }).id;
    const quiet = await bus("message.post", { project: P, kind: "comment_added", ticket_id: main, parent_id: main, body: "quiet", scope: "internal" });
    assert.equal(quiet.status, 200);
    const quietId = (quiet.json as { id: number }).id;
    const pending = ticketOf("an agent's, awaiting moderation", "worker");
    const pending2 = ticketOf("another awaiting moderation", "worker");
    const step = submitMessage({ project: P, kind: "comment_added", ticket_id: main, body: "working", by_agent: "worker", summary_until: "s", handback: true }).id;

    const writes: [string, Record<string, unknown>, number][] = [
        ["ticket.mark_read", { id: main }, 200],
        ["consumer.afk", { name: "worker", action: "toggle" }, 404], // no loop on this test board: LOOP_NOT_FOUND
        ["message.answer_question", { id: plan, qid: "qq1", answered_in: mine }, 200],
        ["ticket.postpone", { id: other, until: new Date(Date.now() + 86_400_000).toISOString() }, 200],
        ["ticket.unsnooze", { id: other }, 200],
        ["message.edit", { id: other, priority: "high" }, 200],
        ["message.edit", { id: other, title: "renamed" }, 200],
        ["message.edit", { id: other, intent: "question" }, 200],
        ["message.edit", { id: other, level: "task" }, 200],
        ["message.edit", { id: other, scope: "default" }, 200],
        ["message.edit", { id: other, body: "new body" }, 200],
        ["message.add_tag", { id: other, tag: "front" }, 200],
        ["message.remove_tag", { id: other, tag: "front" }, 200],
        ["ticket.set_milestone", { id: other, milestone_id: milestone }, 200],
        ["ticket.set_milestone", { id: other, milestone_id: null }, 200],
        ["ticket.assign", { id: other, assignee: "worker" }, 200],
        ["ticket.release", { id: other }, 200],
        ["ticket.set_owner", { id: other, owner: "worker" }, 200],
        ["ticket.relate", { id: other, target_ticket_id: main, kind: "relates_to" }, 200],
        ["ticket.relate", { id: other, target_ticket_id: main, kind: "ignored" }, 200],
        ["message.step", { id: step }, 200],
        ["message.unstep", { id: step }, 200],
        ["message.promote", { id: mine, kind: "plan" }, 200],
        ["message.untag", { id: mine }, 200],
        ["message.vote", { id: plan, value: 1 }, 200],
        ["message.vote", { id: plan, value: 0 }, 200],
        ["message.resurface", { id: mine }, 200],
        ["message.decide", { id: plan, status: "accepted" }, 200],
        ["message.approve", { id: pending }, 200],
        ["message.reject", { id: pending2 }, 200],
        ["message.delete", { id: quietId }, 200],
        ["message.post", { project: P, kind: "ticket_closed", ticket_id: other, parent_id: other }, 200],
        ["message.post", { project: P, kind: "ticket_reopened", ticket_id: other, parent_id: other }, 200],
        ["ticket.move", { id: filed, project: `${P}-b` }, 200],
        ["consumer.set_bar_host", { consumer_id: "worker", host: "external" }, 404], // no loop on this test board: LOOP_NOT_FOUND
    ];
    for (const [method, params, status] of writes) {
        const r = await bus(method, params);
        assert.equal(r.status, status, `${method} ${JSON.stringify(params)} → ${r.status} ${JSON.stringify(r.json)}`);
    }
    const upload = await call("POST", "/api/uploads", Buffer.from("another picture"), { "content-type": "image/png", "x-aiball-upload-name": "b.png" });
    assert.ok(upload.status < 300, JSON.stringify(upload.json));
    assert.equal(typeof (upload.json as { url?: unknown }).url, "string", "tvty reads the upload's url");
});

test("refusals carry a code tvty can branch on", async () => {
    const r = await bus("message.get", { id: 987654321 });
    assert.deepEqual([r.status, (r.json as { code?: string }).code], [404, "MESSAGE_NOT_FOUND"]);
});

test("the rest of tvty's calls: its settings, its loops, its pings, its counters", async () => {
    // A ticket whose last word is an agent's, for tvty to mark as a step.
    const worked = ticketOf("worked on");
    submitMessage({ project: P, kind: "comment_added", ticket_id: worked, body: "done this", by_agent: "worker", summary_until: "s", handback: true });

    const reads: [string, Record<string, unknown>, Shape][] = [
        ["daemon.info", {}, { version: "string" }],
        ["config.managed", {}, { config: [CONFIG_ENTRY] }],
        ["config.managed", { project: P }, { project: "string?", config: [CONFIG_ENTRY] }],
        ["ping.list", { unread: true, limit: 20 }, { pings: [{ message: {} }] }],
        ["loop.list", {}, [{ name: "string", cwd: "string" }]],
        ["session.list", {}, [{ agent: "string?", running: "boolean?" }]],
        ["bus.whoami", {}, {}],
    ];
    for (const [method, params, shape] of reads) {
        const r = await bus(method, params);
        const at = `${method} ${JSON.stringify(params)}`;
        assert.equal(r.status, 200, `${at} → ${r.status} ${JSON.stringify(r.json)}`);
        assert.deepEqual(problems(r.json, shape, at), []);
    }

    // A board setting tvty flips and puts back: one the daemon stores itself.
    const managed = (await bus("config.managed", {})).json as { config: { key: string; type: string; protected?: boolean; sources?: string[]; value: unknown }[] };
    const flag = managed.config.find((e) => e.type === "boolean" && !e.protected && e.sources?.includes("db"));
    assert.ok(flag, "a boolean setting the board stores, for tvty to set");

    const writes: [string, Record<string, unknown>, number][] = [
        ["config.set", { key: flag!.key, value: !flag!.value }, 200],
        ["config.clear", { key: flag!.key }, 200],
        ["consumer.counters", { consumer_id: "worker" }, 200],
        ["ticket.mark_unread", { id: main }, 200],
        ["ticket.step", { id: worked }, 200],
    ];
    for (const [method, params, status] of writes) {
        const r = await bus(method, params);
        assert.equal(r.status, status, `${method} ${JSON.stringify(params)} → ${r.status} ${JSON.stringify(r.json)}`);
    }
});

/**
 * The HTTP routes the tests above exercise, as `docs/API-ROUTES.md` names them:
 * what tvty still calls over HTTP (the rest is on the bus, above).
 */
const COVERED = new Set([
    "POST /api/uploads",
]);

/**
 * #3061 — tvty's calls, read live from its checkout when it sits next to this
 * one (or at AIBALL_TVTY_DIR), with the very reader the route inventory uses:
 * a call tvty adds fails here at once, naming tvty's commit. Without the
 * checkout (Docker, CI), the committed inventory's tvty column stands in.
 */
function tvtyCertainRoutes(): { routes: string[]; source: string } {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const dir = process.env.AIBALL_TVTY_DIR ?? join(root, "../tvty");
    if (existsSync(join(dir, "src"))) {
        const commit = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "?";
        const { certain } = matchCalls(readServerRoutes(root), tvtyCalls(dir));
        return { routes: [...certain], source: `tvty's checkout at ${commit}` };
    }
    const table = readFileSync(join(root, "docs/API-ROUTES.md"), "utf8");
    const header = table.split("\n").find((l) => l.startsWith("| Route |"))!.split("|").map((c) => c.trim());
    const col = header.indexOf("tvty");
    const routes = table.split("\n")
        .filter((l) => l.startsWith("| `"))
        .map((l) => l.split("|"))
        .filter((cells) => cells[col]!.trim() === "●")
        .map((cells) => cells[1]!.trim().replace(/`/g, ""));
    return { routes, source: "docs/API-ROUTES.md (tvty's checkout not found)" };
}

/**
 * The bus methods tvty calls, and where each is held: `true` when a test above
 * calls it, else the test that covers it — a method that needs a running loop,
 * a session host or a project on disk is exercised where those are set up.
 */
const COVERED_METHODS: Record<string, true | string> = {
    "consumer.list": true, "inbox.list": true, "ticket.get": true, "message.get": true, "consumer.backlog": true,
    "tag.list": true, "project.milestones": true, "mention.suggestions": true, "message.post": true,
    "ticket.mark_read": true, "consumer.afk": true, "message.answer_question": true, "ticket.postpone": true,
    "ticket.unsnooze": true, "message.edit": true, "message.add_tag": true, "message.remove_tag": true,
    "ticket.set_milestone": true, "ticket.assign": true, "ticket.release": true, "ticket.set_owner": true,
    "ticket.relate": true, "message.step": true, "message.unstep": true, "message.promote": true,
    "message.untag": true, "message.vote": true, "message.resurface": true, "message.decide": true,
    "message.approve": true, "message.reject": true, "message.delete": true, "ticket.move": true,
    "daemon.info": true, "config.managed": true, "config.set": true, "config.clear": true, "ping.list": true,
    "loop.list": true, "session.list": true, "bus.whoami": true, "consumer.counters": true,
    "ticket.mark_unread": true, "ticket.step": true,
    "bus.subscribe": "src/bus/counters.test.ts, src/bus/config-changed.test.ts (on a bus connection)",
    "session.start": "src/sessions/sessions.test.ts (a session host)",
    "session.stop": "src/sessions/sessions.test.ts, src/sessions/stop-hup.test.ts (a session host)",
    "loop.restart": "src/bus/loop-methods.test.ts (a loop on disk)",
    "consumer.stop_loop": "src/bus/loops-admin.test.ts (a running loop)",
    "consumer.restart_claude": "src/bus/restart-claude.test.ts (a running loop)",
    "project.init": "src/bus/project-init.test.ts (a project folder)",
    "project.settings_set": "src/bus/project-settings.test.ts (a project folder)",
};

/**
 * #3279 — tvty's bus methods, read as its routes are: from its checkout when
 * it is there, else from the list the route inventory commits.
 */
function tvtyMethods(): { methods: string[]; source: string } {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const dir = process.env.AIBALL_TVTY_DIR ?? join(root, "../tvty");
    if (existsSync(join(dir, "src"))) {
        const commit = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "?";
        return { methods: tvtyBusMethods(dir, methodNames()), source: `tvty's checkout at ${commit}` };
    }
    const table = readFileSync(join(root, "docs/API-ROUTES.md"), "utf8");
    const section = table.split("## Bus methods tvty calls")[1] ?? "";
    const methods = [...section.matchAll(/^- `([a-z_]+\.[a-z_]+)`$/gm)].map((m) => m[1]!);
    return { methods, source: "docs/API-ROUTES.md (tvty's checkout not found)" };
}

test("every bus method tvty calls is covered", () => {
    const { methods, source } = tvtyMethods();
    // The reading worked: tvty opens every thread with ticket.get.
    assert.ok(methods.includes("ticket.get"), `tvty's methods were read (${source}): ${methods.join(", ") || "none"}`);
    assert.deepEqual(methods.filter((m) => !(m in COVERED_METHODS)).sort(), [], `tvty calls these (${source}) and no test covers them`);
    // A method named here that the bus no longer has is a contract broken, not a stale line.
    const known = new Set(methodNames());
    assert.deepEqual(Object.keys(COVERED_METHODS).filter((m) => !known.has(m)), [], "methods named here that the bus does not have");
});

test("every route tvty calls (●) is covered here", () => {
    const { routes, source } = tvtyCertainRoutes();
    // #3068 — tvty is on the bus; over HTTP it keeps its uploads. Their route
    // among the ones read says the reading worked.
    assert.ok(routes.includes("POST /api/uploads"), `tvty's calls were read (${source}): ${routes.join(", ") || "none"}`);
    assert.deepEqual(routes.filter((r) => !COVERED.has(r)).sort(), [], `tvty calls these (${source}) and no test here covers them`);
});
