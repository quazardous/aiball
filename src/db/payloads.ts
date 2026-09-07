/**
 * #2109 — storage for a ticket's payload zone.
 *
 * The whole point of this module is the SHAPE of what it exports, so read this
 * before adding to it.
 *
 * There are two readers. `readTicketPayload()` returns the FILTERED projection
 * and is what every surface uses — API, MCP, UI, exports. `readTicketPayloadRaw()`
 * returns the values themselves and is meant to have exactly ONE caller, the
 * deliberate dump route behind `aiball payload dump`.
 *
 * That asymmetry is the guarantee. "Everything is secret by default" cannot be
 * enforced by asking each call site to redact — it holds only if the unredacted
 * values are awkward to reach and obvious in a diff when someone does. Hence a
 * second function with a name that says what it hands out, rather than a flag
 * on the first one that a caller can pass without thinking.
 */
import { eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import {
    type FilteredPayload,
    filterPayload,
    parsePublicKeys,
} from "./ticket-payload.js";

export interface TicketPayloadRow {
    ticket_id: number;
    payload: string | null;
    schema: string | null;
    created_at: string;
    updated_at: string;
    by_agent: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
    revoked_keys: string | null;
}

/** What a payload looks like once filtered: keys always, values if public. */
export interface TicketPayloadView {
    ticket_id: number;
    /** The declared PUBLIC keys. Empty means every key is secret. */
    schema: string[];
    /** Every key in the payload, in insertion order — visible even when the
     *  values are not, so a payload can be audited without being read. After
     *  revocation these come from the tombstone, so the row still says WHICH
     *  credential was destroyed. */
    keys: string[];
    payload: FilteredPayload;
    created_at: string;
    updated_at: string;
    by_agent: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
}

function rowOf(ticketId: number): TicketPayloadRow | null {
    const rows = getDb()
        .select()
        .from(schema.ticketPayloads)
        .where(eq(schema.ticketPayloads.ticketId, ticketId))
        .all();
    const r = rows[0];
    if (!r) return null;
    return {
        ticket_id: r.ticketId,
        payload: r.payload,
        schema: r.schema,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        by_agent: r.byAgent,
        revoked_at: r.revokedAt,
        revoked_by: r.revokedBy,
        revoked_keys: r.revokedKeys,
    };
}

/**
 * Parse a stored payload. A column that isn't a JSON object reads as an empty
 * payload rather than throwing: a corrupted row must degrade to "no keys", not
 * take down every ticket read that happens to touch it.
 */
function parsePayload(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Does this ticket carry a payload at all? Cheap, and leaks nothing. */
export function ticketHasPayload(ticketId: number): boolean {
    return rowOf(ticketId) !== null;
}

/**
 * The filtered view — the ONE every surface should call.
 *
 * A revoked payload keeps its row and its key list (the trace that it existed)
 * but has no values left to show.
 */
export function readTicketPayload(ticketId: number): TicketPayloadView | null {
    const row = rowOf(ticketId);
    if (!row) return null;
    const publicKeys = parsePublicKeys(row.schema);
    const payload = parsePayload(row.payload);
    // A revoked row has no payload left to derive keys from — they come from
    // the tombstone instead. `parsePublicKeys` is reused because it is the same
    // shape (a JSON array of strings) with the same safe fallback.
    const keys = row.revoked_at ? parsePublicKeys(row.revoked_keys) : Object.keys(payload);
    return {
        ticket_id: row.ticket_id,
        schema: publicKeys,
        keys,
        payload: filterPayload(payload, publicKeys),
        created_at: row.created_at,
        updated_at: row.updated_at,
        by_agent: row.by_agent,
        revoked_at: row.revoked_at,
        revoked_by: row.revoked_by,
    };
}

/**
 * The values themselves.
 *
 * ONE caller: the dump route. If you are about to add a second, the thing you
 * want is almost certainly `readTicketPayload()` above — and if it genuinely
 * isn't, say so in a comment at the new call site, because this function is
 * the only way a secret leaves the database.
 */
export function readTicketPayloadRaw(ticketId: number): Record<string, unknown> | null {
    const row = rowOf(ticketId);
    if (!row || row.revoked_at) return null;
    return parsePayload(row.payload);
}

/** Deposit or replace a payload. `publicKeys` absent => everything secret. */
export function writeTicketPayload(
    ticketId: number,
    payload: Record<string, unknown>,
    publicKeys: readonly string[] | null | undefined,
    byAgent: string,
): TicketPayloadView {
    const now = nowIso();
    const db = getDb();
    const existing = rowOf(ticketId);
    const values = {
        payload: JSON.stringify(payload),
        schema: JSON.stringify([...(publicKeys ?? [])]),
        updatedAt: now,
        byAgent,
        // Re-depositing on a revoked ticket revives the zone: the values are
        // new, so the old revocation no longer describes them.
        revokedAt: null,
        revokedBy: null,
        revokedKeys: null,
    };
    if (existing) {
        db.update(schema.ticketPayloads)
            .set(values)
            .where(eq(schema.ticketPayloads.ticketId, ticketId))
            .run();
    } else {
        db.insert(schema.ticketPayloads)
            .values({ ticketId, createdAt: now, ...values })
            .run();
    }
    return readTicketPayload(ticketId) as TicketPayloadView;
}

/**
 * Destroy the values, keep the trace.
 *
 * Same tombstone shape as node revocations (migration 0062): a vault whose row
 * simply vanished would leave the "did my click work?" ambiguity that pattern
 * was written to end — and, worse here, would make it impossible to tell a
 * secret that was revoked from one that was never deposited.
 */
export function revokeTicketPayload(ticketId: number, by: string): TicketPayloadView | null {
    const row = rowOf(ticketId);
    if (!row) return null;
    const now = nowIso();
    getDb()
        .update(schema.ticketPayloads)
        .set({
            payload: null,
            updatedAt: now,
            revokedAt: row.revoked_at ?? now,
            revokedBy: row.revoked_by ?? by,
            // Copied BEFORE the values go, and only on the first revocation so
            // a second call cannot overwrite the trace with an empty list.
            revokedKeys: row.revoked_keys ?? JSON.stringify(Object.keys(parsePayload(row.payload))),
        })
        .where(eq(schema.ticketPayloads.ticketId, ticketId))
        .run();
    return readTicketPayload(ticketId);
}
