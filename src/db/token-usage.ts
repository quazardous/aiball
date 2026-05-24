/**
 * #404 — per-ticket token-effort tally storage (the SAFE, daemon-only half).
 *
 * The claude-loop capture side (MCP `active-ticket` marker + Stop-hook reading
 * the session transcript's `usage` and pushing a delta) lands in a separate
 * cold pass — it touches live loop components. This module is just the sink:
 * accumulate deltas onto a ticket, read them back. Table `ticket_token_usage`
 * (migration 0032). Raw counts; consumers derive a cost estimate (cache_r is
 * cheap, ~0.1×).
 */
import { inArray, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

/** A turn's usage delta (any subset; missing = 0). */
export interface TokenDelta {
    in?: number;
    out?: number;
    cacheW?: number;
    cacheR?: number;
}

/** Accumulated tally for a ticket (snake_case, API-facing shape). */
export interface TokenTally {
    tokens_in: number;
    tokens_out: number;
    cache_w: number;
    cache_r: number;
    updated_at: string;
}

/** #404: add a turn's usage onto a ticket (upsert + accumulate). */
export function addTicketTokenUsage(ticket_id: number, d: TokenDelta): void {
    const now = nowIso();
    const i = d.in ?? 0, o = d.out ?? 0, cw = d.cacheW ?? 0, cr = d.cacheR ?? 0;
    getDb().insert(schema.ticketTokenUsage).values({
        ticketId: ticket_id,
        tokensIn: i, tokensOut: o, cacheW: cw, cacheR: cr,
        updatedAt: now,
    }).onConflictDoUpdate({
        target: schema.ticketTokenUsage.ticketId,
        set: {
            tokensIn: sql`${schema.ticketTokenUsage.tokensIn} + ${i}`,
            tokensOut: sql`${schema.ticketTokenUsage.tokensOut} + ${o}`,
            cacheW: sql`${schema.ticketTokenUsage.cacheW} + ${cw}`,
            cacheR: sql`${schema.ticketTokenUsage.cacheR} + ${cr}`,
            updatedAt: now,
        },
    }).run();
}

/** #404: read accumulated tallies for a set of tickets (absent = no usage yet). */
export function getTicketTokenUsage(ticket_ids: number[]): Map<number, TokenTally> {
    const out = new Map<number, TokenTally>();
    if (ticket_ids.length === 0) return out;
    const rows = getDb().select().from(schema.ticketTokenUsage)
        .where(inArray(schema.ticketTokenUsage.ticketId, ticket_ids)).all();
    for (const r of rows) {
        out.set(r.ticketId, {
            tokens_in: r.tokensIn, tokens_out: r.tokensOut,
            cache_w: r.cacheW, cache_r: r.cacheR, updated_at: r.updatedAt,
        });
    }
    return out;
}
