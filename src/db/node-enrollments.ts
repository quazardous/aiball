// #2074 — storing and deciding pairing requests. The rules live next door in
// `node-enrollment.ts`, pure; this is the part that touches the database.

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import { issueToken } from "./tokens.js";
import {
    ENROLLMENT_TTL_MS,
    enrollmentState,
    isCollectable,
    isDecidable,
    makePairingCode,
    type EnrollmentState,
} from "./node-enrollment.js";

/** What a request looks like to the hub's UI. Never carries the token. */
export interface EnrollmentView {
    id: string;
    code: string;
    label: string | null;
    requested_ip: string | null;
    created_at: string;
    expires_at: string;
    state: EnrollmentState;
    decided_at: string | null;
    decided_by: string | null;
}

function toView(r: typeof schema.nodeEnrollments.$inferSelect, nowMs: number): EnrollmentView {
    return {
        id: r.id,
        code: r.code,
        label: r.label,
        requested_ip: r.requestedIp,
        created_at: r.createdAt,
        expires_at: r.expiresAt,
        state: enrollmentState(
            { status: r.status, expires_at: r.expiresAt, delivered_at: r.deliveredAt },
            nowMs,
        ),
        decided_at: r.decidedAt,
        decided_by: r.decidedBy,
    };
}

/**
 * Record a request. Mints NOTHING — that is the whole guarantee of the
 * unauthenticated route: the worst a stranger achieves is a row a human will
 * not recognise and will not approve.
 */
export function createEnrollment(input: { label?: string | null; ip?: string | null }): EnrollmentView {
    const now = Date.now();
    const row = {
        id: randomBytes(16).toString("hex"),
        code: makePairingCode(),
        label: input.label?.slice(0, 120) ?? null,
        requestedIp: input.ip ?? null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ENROLLMENT_TTL_MS).toISOString(),
        status: "pending",
    };
    getDb().insert(schema.nodeEnrollments).values(row).run();
    return toView({ ...row, decidedAt: null, decidedBy: null, token: null, deliveredAt: null }, now);
}

function rowOf(id: string) {
    return getDb().select().from(schema.nodeEnrollments)
        .where(eq(schema.nodeEnrollments.id, id)).get();
}

/** One request, as the UI or the polling node sees it. */
export function getEnrollment(id: string): EnrollmentView | null {
    const r = rowOf(id);
    return r ? toView(r, Date.now()) : null;
}

/**
 * Everything a human might still act on, plus what was decided recently so the
 * panel doesn't blink an approval out of existence the moment it lands.
 */
export function listEnrollments(): EnrollmentView[] {
    const now = Date.now();
    return getDb().select().from(schema.nodeEnrollments)
        .all()
        .map((r) => toView(r, now))
        .filter((v) => v.state !== "expired")
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Approve: THIS is where a credential first exists, and it is a human action.
 * Returns null when the request is no longer decidable — expired, or already
 * decided — so a stale panel cannot mint a second token by double-clicking.
 */
export function approveEnrollment(id: string, by: string): EnrollmentView | null {
    const r = rowOf(id);
    if (!r) return null;
    const now = Date.now();
    if (!isDecidable({ status: r.status, expires_at: r.expiresAt, delivered_at: r.deliveredAt }, now)) {
        return null;
    }
    const token = issueToken({ kind: "node", label: r.label ?? null });
    const decidedAt = nowIso();
    getDb().update(schema.nodeEnrollments)
        .set({ status: "approved", decidedAt, decidedBy: by, token: token.token })
        // Re-check the status in the WHERE so two concurrent approvals cannot
        // both mint: the second updates zero rows and its token stays unused.
        .where(and(eq(schema.nodeEnrollments.id, id), eq(schema.nodeEnrollments.status, "pending")))
        .run();
    return getEnrollment(id);
}

/** Refuse. Final: the row keeps its trace so the panel can say what happened. */
export function rejectEnrollment(id: string, by: string): EnrollmentView | null {
    const r = rowOf(id);
    if (!r) return null;
    if (!isDecidable({ status: r.status, expires_at: r.expiresAt, delivered_at: r.deliveredAt }, Date.now())) {
        return null;
    }
    getDb().update(schema.nodeEnrollments)
        .set({ status: "rejected", decidedAt: nowIso(), decidedBy: by })
        .where(eq(schema.nodeEnrollments.id, id))
        .run();
    return getEnrollment(id);
}

/**
 * Hand the token to the node, ONCE. The column is cleared in the same breath,
 * so a request that leaks later carries nothing: it is a receipt, not a key.
 */
export function collectEnrollmentToken(id: string): string | null {
    const r = rowOf(id);
    if (!r || !r.token) return null;
    if (!isCollectable({ status: r.status, expires_at: r.expiresAt, delivered_at: r.deliveredAt }, Date.now())) {
        return null;
    }
    getDb().update(schema.nodeEnrollments)
        .set({ token: null, deliveredAt: nowIso() })
        .where(eq(schema.nodeEnrollments.id, id))
        .run();
    return r.token;
}
