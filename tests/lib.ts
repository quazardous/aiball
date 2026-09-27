// #324 e2e helpers — shared by every tests/scenario-*.ts (the one test stack,
// #dz8sm5). Scenarios drive the real daemon through the BUSINESS API only
// (audit "business, not CRUD" #cta34j); they run INSIDE the daemon container
// (`docker compose exec`), sharing the DB for token minting + reaching the
// daemon on localhost. The only non-API touch allowed is agent provisioning.
import { eq } from "drizzle-orm";
import { issueToken } from "../src/db/tokens.js";
import { ensureConsumer, getDb } from "../src/db.js";
import * as schema from "../src/schema.js";
import { createProject, getProject } from "../src/db/projects.js";
import { upsertSubscription } from "../src/db/subscriptions.js";
import { BusClient, BusError } from "../src/bus-client.js";

export const BASE = "http://127.0.0.1:7777";

/** Register a pseudo-agent (FK) and mint its bearer token. */
export function provision(consumer: string): string {
    ensureConsumer(consumer);
    return issueToken({ kind: "agent", consumer_id: consumer, label: "e2e" }).token;
}

/**
 * Register a project and its owners — provisioning, like `provision`: posting
 * into a project that was never created is refused, and an agent's backlog
 * only holds the projects it leads. Idempotent across scenarios sharing the
 * daemon.
 */
export function provisionProject(name: string, owners: string[] = []): void {
    if (!getProject(name)) createProject({ name });
    for (const owner of owners) {
        ensureConsumer(owner);
        upsertSubscription(owner, name, "owner");
    }
}

/**
 * Register a HUMAN consumer (kind=human) and mint its token. Same provisioning
 * carve-out as `provision`, but flips the consumer kind so it counts as human
 * for the gate's recency rule (#358 — a pending decision yields to a later
 * HUMAN comment) and for the summary_until exemption (humans skip it).
 */
export function provisionHuman(consumer: string): string {
    ensureConsumer(consumer);
    getDb().update(schema.consumers).set({ kind: "human" }).where(eq(schema.consumers.consumerId, consumer)).run();
    return issueToken({ kind: "auth", consumer_id: consumer, label: "e2e" }).token;
}

/**
 * #3068 — a call to the core, on the bus, as the token's consumer: one
 * connection per call. A refusal throws `method → status: {"error","code"}`,
 * the shape the HTTP helpers threw.
 */
export async function bus<T = Record<string, unknown>>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const r = await busRaw<T>(token, method, params);
    if (r.code >= 400) throw new Error(`${method} → ${r.code}: ${JSON.stringify(r.body)}`);
    return r.body as T;
}

/** The same, returning the refusal's status instead of throwing: for the scenarios that assert it (403, 400…). */
export async function busRaw<T = Record<string, unknown>>(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ code: number; body: T | { error: string; code: string } }> {
    const c = await BusClient.connect({ url: BASE, token });
    try {
        return { code: 200, body: await c.call<T>(method, params) };
    } catch (e) {
        if (e instanceof BusError) return { code: e.status, body: { error: e.message, code: e.code } };
        throw e;
    } finally {
        c.close();
    }
}

export async function post(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return bus(token, "message.post", body);
}

export async function unread(token: string, consumer: string, project: string): Promise<Record<string, unknown>> {
    return bus(token, "unread.list", { consumer_id: consumer, project, limit: 100 });
}

/**
 * List tickets for a project as the token's consumer (per-consumer flags).
 * `actionable: true` → the candidate pool the decision/last-actor gates carve
 * out; `open: true` → the broader open set.
 */
export async function tickets(
    token: string,
    project: string,
    opts: { actionable?: boolean; open?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
    return bus(token, "ticket.list", { project, ...(opts.actionable ? { actionable: "1" } : {}), ...(opts.open ? { open: "1" } : {}) });
}

/** Accept/reject a decision-on-comment (#B.129). */
export async function decide(token: string, messageId: number, status: "accepted" | "rejected"): Promise<Record<string, unknown>> {
    return bus(token, "message.decide", { id: messageId, status });
}

/**
 * Create a moderation rule: an automation rule on `message_posted` with a
 * `decision` action (moderation reads only those). Returns the inserted rule
 * (its `id`, to assert `matched_rule_id` on routed messages).
 */
export async function createRule(
    token: string,
    rule: {
        decision: "auto" | "review";
        match_project?: string;
        match_kind?: string;
        match_by_agent?: string;
        position?: number;
        note?: string;
    },
): Promise<Record<string, unknown>> {
    const { decision, ...match } = rule;
    return bus(token, "automation.create_rule", { triggers: ["message_posted"], action: { kind: "decision", decision }, ...match });
}

/** Move a ticket to another project (#294). */
export async function move(token: string, ticketId: number, project: string): Promise<Record<string, unknown>> {
    return bus(token, "ticket.move", { id: ticketId, project });
}

/** #418: assign/claim a ticket. Omit `assignee` to self-claim. */
export async function assign(token: string, ticketId: number, assignee?: string): Promise<Record<string, unknown>> {
    return bus(token, "ticket.assign", { id: ticketId, ...(assignee ? { assignee } : {}) });
}

/** #418: release a ticket's assignment / claim. */
export async function release(token: string, ticketId: number): Promise<Record<string, unknown>> {
    return bus(token, "ticket.release", { id: ticketId });
}

/** A moderator approves a pending ticket or comment. */
export async function approve(token: string, messageId: number): Promise<Record<string, unknown>> {
    return bus(token, "message.approve", { id: messageId });
}

/** Parse a message's `meta` (JSON string or object) to read `.decision`. */
export function metaDecision(m: Record<string, unknown>): { kind?: string; status?: string } | null {
    const raw = m.meta;
    if (!raw) return null;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return (obj as { decision?: { kind?: string; status?: string } }).decision ?? null;
}

export function ok(msg: string): void {
    console.log(`OK: ${msg}`);
}

export function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}
