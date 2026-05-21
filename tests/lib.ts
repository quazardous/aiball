// #324 e2e helpers — shared by every tests/scenario-*.ts (the one test stack,
// #dz8sm5). Scenarios drive the real daemon through the BUSINESS API only
// (audit "business, not CRUD" #cta34j); they run INSIDE the daemon container
// (`docker compose exec`), sharing the DB for token minting + reaching the
// daemon on localhost. The only non-API touch allowed is agent provisioning.
import { eq } from "drizzle-orm";
import { issueToken } from "../src/db/tokens.js";
import { ensureConsumer, getDb } from "../src/db.js";
import * as schema from "../src/schema.js";

export const BASE = "http://127.0.0.1:7777";

/** Register a pseudo-agent (FK) and mint its bearer token. */
export function provision(consumer: string): string {
    ensureConsumer(consumer);
    return issueToken({ kind: "agent", consumer_id: consumer, label: "e2e" }).token;
}

/**
 * Push `next_message_id` far above the ticket-id space so a fresh container DB
 * doesn't hit the next_ticket_id/next_message_id collision (getMessage is
 * tickets-first → a comment id colliding with a ticket id misresolves). Only
 * needed by scenarios that address a comment BY ID (e.g. /decide/:id). Never
 * regresses the counter (idempotent across scenarios sharing the daemon).
 */
export function seedCounters(): void {
    const db = getDb();
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, "next_message_id")).get();
    const cur = row ? Number(row.value) : 1;
    if (cur < 1_000_000) {
        db.insert(schema.settings)
            .values({ key: "next_message_id", value: "1000000" })
            .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } })
            .run();
    }
}

export async function post(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST /api/messages → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

export async function unread(token: string, consumer: string, project: string): Promise<Record<string, unknown>> {
    const r = await fetch(
        `${BASE}/api/unread?consumer_id=${encodeURIComponent(consumer)}&project=${encodeURIComponent(project)}&limit=100`,
        { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await r.text();
    if (!r.ok) throw new Error(`GET /api/unread → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

/** Accept/reject a decision-on-comment (#B.129): POST /api/messages/:id/decide. */
export async function decide(token: string, messageId: number, status: "accepted" | "rejected"): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/api/messages/${messageId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST /api/messages/${messageId}/decide → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
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
