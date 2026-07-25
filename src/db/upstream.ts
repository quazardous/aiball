/**
 * Upstream coupling (GitHub / GitLab), phase 2 — DB helpers for the
 * per-ticket link (columns added in migration 0053). A ticket is "coupled"
 * when these columns are set; ALL NULL = a pure aiball ticket the driver
 * never touches. See src/upstream-import.ts for the orchestration.
 */
import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso, ticketRowToMessage, type Message } from "./connection.js";

export interface UpstreamCoupling {
    /** Provider id, e.g. "github" (UpstreamProvider.id). */
    kind: string;
    /** Canonical provider ref, e.g. "github:owner/repo". */
    ref: string;
    /** External issue number. */
    num: number;
    /** Last successful sync (ISO8601). Defaults to now when omitted. */
    syncedAt?: string | null;
}

/** Set (or refresh) a ticket's upstream coupling columns. */
export function setTicketUpstream(ticketId: number, c: UpstreamCoupling): void {
    getDb().update(schema.tickets).set({
        upstreamKind: c.kind,
        upstreamRef: c.ref,
        upstreamNum: c.num,
        upstreamSyncedAt: c.syncedAt ?? nowIso(),
    }).where(eq(schema.tickets.id, ticketId)).run();
}

/**
 * Find a ticket in `project` already coupled to (kind, ref, num). Used to
 * keep import idempotent — re-importing the same issue must not fork a
 * duplicate ticket. Null when no ticket is coupled to that external issue.
 */
export function findCoupledTicket(
    project: string,
    kind: string,
    ref: string,
    num: number,
): Message | null {
    const r = getDb().select().from(schema.tickets).where(and(
        eq(schema.tickets.project, project),
        eq(schema.tickets.upstreamKind, kind),
        eq(schema.tickets.upstreamRef, ref),
        eq(schema.tickets.upstreamNum, num),
    )).get();
    return r ? ticketRowToMessage(r) : null;
}
