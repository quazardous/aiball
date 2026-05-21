// #324 e2e helpers — shared by every tests/scenario-*.ts (the one test stack,
// #dz8sm5). Scenarios drive the real daemon through the BUSINESS API only
// (audit "business, not CRUD" #cta34j); they run INSIDE the daemon container
// (`docker compose exec`), sharing the DB for token minting + reaching the
// daemon on localhost. The only non-API touch allowed is agent provisioning.
import { issueToken } from "../src/db/tokens.js";
import { ensureConsumer } from "../src/db.js";

export const BASE = "http://127.0.0.1:7777";

/** Register a pseudo-agent (FK) and mint its bearer token. */
export function provision(consumer: string): string {
    ensureConsumer(consumer);
    return issueToken({ kind: "agent", consumer_id: consumer, label: "e2e" }).token;
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

export function ok(msg: string): void {
    console.log(`OK: ${msg}`);
}

export function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}
