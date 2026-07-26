/**
 * Upstream coupling (GitHub / GitLab), phase 2 — DB helpers for the
 * per-ticket link (columns added in migration 0053). A ticket is "coupled"
 * when these columns are set; ALL NULL = a pure aiball ticket the driver
 * never touches. See src/upstream-import.ts for the orchestration.
 */
import { and, eq, isNotNull } from "drizzle-orm";
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

/** A coupled ticket, reduced to what the link watcher needs. No content. */
export interface CoupledTicket {
    id: number;
    project: string;
    kind: string;
    ref: string;
    num: number;
    /** Remote `updated_at` as last observed (the watermark). */
    seenAt: string | null;
}

/**
 * #1566 — every ticket carrying a coupling, for the periodic link watch.
 *
 * `upstream_num` is the column that decides: per the storage rule (david
 * `nz7v87`), `kind`/`ref` stay EMPTY when the ticket rides the project's
 * default binding, so testing those would miss most couplings. Closed tickets
 * are skipped — a closed ticket has nothing to be woken about.
 */
export function listCoupledTickets(): CoupledTicket[] {
    const rows = getDb().select({
        id: schema.tickets.id,
        project: schema.tickets.project,
        kind: schema.tickets.upstreamKind,
        ref: schema.tickets.upstreamRef,
        num: schema.tickets.upstreamNum,
        seenAt: schema.tickets.upstreamSeenAt,
        status: schema.tickets.status,
    }).from(schema.tickets).where(isNotNull(schema.tickets.upstreamNum)).all();
    return rows
        .filter((r) => r.status !== "rejected" && typeof r.num === "number")
        .map((r) => ({
            id: r.id,
            project: r.project,
            kind: r.kind ?? "github",
            ref: r.ref ?? "",
            num: r.num as number,
            seenAt: r.seenAt ?? null,
        }));
}

/**
 * Record the outcome of a probe. `seenAt` is only passed when the watermark
 * should move — a failed probe must NOT advance it, or the change it failed to
 * read would be lost for good.
 */
export function recordUpstreamProbe(
    ticketId: number,
    outcome: { ok: boolean; seenAt?: string | null; error?: string | null },
): void {
    const now = nowIso();
    const patch: Record<string, unknown> = { upstreamCheckedAt: now };
    if (outcome.ok) {
        patch.upstreamSyncedAt = now;
        patch.upstreamError = null;
        if (outcome.seenAt) patch.upstreamSeenAt = outcome.seenAt;
    } else {
        patch.upstreamError = outcome.error ?? "unknown error";
    }
    getDb().update(schema.tickets).set(patch).where(eq(schema.tickets.id, ticketId)).run();
}
