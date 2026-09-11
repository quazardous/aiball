/**
 * #2255 — external signals: a synthetic wake from a system outside the board.
 *
 * Deliberately NOT a ticket or a comment (david: "il faut pas mélanger"): a
 * signal never enters a backlog and cannot turn into a ticket. It lives here,
 * with one delivery row per recipient, until that recipient's loop injects it
 * and acks it, or until it expires.
 */
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import { isHuman, seesLevel } from "./consumers.js";
import { listProjectSubscribers } from "./subscriptions.js";
import { TICKET_LEVELS, type TicketLevel } from "../domain.js";
import type { SignalEvent } from "../event-bus.js";

export const SIGNAL_TITLE_MAX = 200;
export const SIGNAL_BODY_MAX = 2000;
export const SIGNAL_TTL_DEFAULT_S = 3600;
export const SIGNAL_TTL_MAX_S = 86_400;

export type SignalTarget = { consumer: string } | { project: string; level: TicketLevel };

export interface SignalInput {
    source: string;
    target: SignalTarget;
    title: string;
    body?: string | null;
    severity?: "normal" | "panic";
    dedup_key?: string | null;
    ttl_s?: number;
}

/** Validate a request body into a SignalInput, or say what is wrong. */
export function parseSignalBody(source: string, raw: unknown): SignalInput | { error: string } {
    const b = (raw ?? {}) as Record<string, unknown>;
    const t = (b.target ?? {}) as Record<string, unknown>;
    let target: SignalTarget;
    if (typeof t.consumer === "string" && t.consumer && t.project === undefined) {
        target = { consumer: t.consumer };
    } else if (typeof t.project === "string" && t.project && t.consumer === undefined) {
        if (typeof t.level !== "string" || !(TICKET_LEVELS as readonly string[]).includes(t.level)) {
            return { error: `target.level is required with target.project: one of ${TICKET_LEVELS.join(", ")}` };
        }
        target = { project: t.project, level: t.level as TicketLevel };
    } else {
        return { error: "target must be { consumer } or { project, level }" };
    }
    if (typeof b.title !== "string" || !b.title.trim()) return { error: "title is required" };
    if (b.title.length > SIGNAL_TITLE_MAX) return { error: `title is limited to ${SIGNAL_TITLE_MAX} characters` };
    if (b.body !== undefined && b.body !== null && typeof b.body !== "string") return { error: "body must be a string" };
    if (typeof b.body === "string" && b.body.length > SIGNAL_BODY_MAX) return { error: `body is limited to ${SIGNAL_BODY_MAX} characters` };
    if (b.severity !== undefined && b.severity !== "normal" && b.severity !== "panic") return { error: "severity must be normal or panic" };
    if (b.dedup_key !== undefined && b.dedup_key !== null && typeof b.dedup_key !== "string") return { error: "dedup_key must be a string" };
    let ttl = SIGNAL_TTL_DEFAULT_S;
    if (b.ttl !== undefined) {
        if (typeof b.ttl !== "number" || !Number.isInteger(b.ttl) || b.ttl < 1 || b.ttl > SIGNAL_TTL_MAX_S) {
            return { error: `ttl is a number of seconds between 1 and ${SIGNAL_TTL_MAX_S}` };
        }
        ttl = b.ttl;
    }
    return {
        source,
        target,
        title: b.title.trim(),
        body: typeof b.body === "string" ? b.body : null,
        severity: (b.severity as "normal" | "panic" | undefined) ?? "normal",
        dedup_key: typeof b.dedup_key === "string" && b.dedup_key ? b.dedup_key : null,
        ttl_s: ttl,
    };
}

/**
 * Who a target reaches: the named agent, or the project's owners that work on
 * the level (#2241). Humans are left out — a signal wakes a loop, and a human
 * has none.
 */
export function resolveSignalRecipients(target: SignalTarget): string[] {
    if ("consumer" in target) return [target.consumer];
    return listProjectSubscribers(target.project, { roles: ["owner"] })
        .filter((c) => !isHuman(c) && seesLevel(c, target.level));
}

function toEvent(r: schema.Signal): SignalEvent {
    return {
        id: r.id,
        source: r.source,
        title: r.title,
        body: r.body,
        severity: r.severity === "panic" ? "panic" : "normal",
        repeat_count: r.repeatCount,
        expires_at: r.expiresAt,
    };
}

export interface PostedSignal {
    signal: SignalEvent;
    recipients: string[];
    /** true when an unacked signal with the same source + dedup_key was refreshed instead. */
    refreshed: boolean;
}

export function postSignal(input: SignalInput, nowMs: number = Date.now()): PostedSignal {
    const db = getDb();
    const now = new Date(nowMs).toISOString();
    const expires = new Date(nowMs + (input.ttl_s ?? SIGNAL_TTL_DEFAULT_S) * 1000).toISOString();
    if (input.dedup_key) {
        const existing = db.select().from(schema.signals)
            .where(and(
                eq(schema.signals.source, input.source),
                eq(schema.signals.dedupKey, input.dedup_key),
                gt(schema.signals.expiresAt, now),
            ))
            .orderBy(desc(schema.signals.id))
            .get();
        if (existing) {
            const waiting = db.select({ recipient: schema.signalDeliveries.recipient })
                .from(schema.signalDeliveries)
                .where(and(eq(schema.signalDeliveries.signalId, existing.id), isNull(schema.signalDeliveries.ackedAt)))
                .all()
                .map((r) => r.recipient);
            if (waiting.length > 0) {
                db.update(schema.signals).set({
                    title: input.title,
                    body: input.body ?? null,
                    severity: input.severity ?? "normal",
                    repeatCount: existing.repeatCount + 1,
                    updatedAt: now,
                    expiresAt: expires,
                }).where(eq(schema.signals.id, existing.id)).run();
                const row = db.select().from(schema.signals).where(eq(schema.signals.id, existing.id)).get()!;
                return { signal: toEvent(row), recipients: waiting, refreshed: true };
            }
        }
    }
    const recipients = [...new Set(resolveSignalRecipients(input.target))];
    const inserted = db.insert(schema.signals).values({
        source: input.source,
        targetConsumer: "consumer" in input.target ? input.target.consumer : null,
        targetProject: "project" in input.target ? input.target.project : null,
        targetLevel: "project" in input.target ? input.target.level : null,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity ?? "normal",
        dedupKey: input.dedup_key ?? null,
        createdAt: now,
        updatedAt: now,
        expiresAt: expires,
    }).returning().get();
    for (const recipient of recipients) {
        db.insert(schema.signalDeliveries).values({ signalId: inserted.id, recipient }).run();
    }
    return { signal: toEvent(inserted), recipients, refreshed: false };
}

/** Signals waiting for this consumer: unacked, unexpired, `panic` first, then oldest first. */
export function listPendingSignals(consumer: string, now: string = nowIso()): SignalEvent[] {
    const db = getDb();
    const ids = db.select({ id: schema.signalDeliveries.signalId })
        .from(schema.signalDeliveries)
        .where(and(eq(schema.signalDeliveries.recipient, consumer), isNull(schema.signalDeliveries.ackedAt)))
        .all()
        .map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(schema.signals)
        .where(and(inArray(schema.signals.id, ids), gt(schema.signals.expiresAt, now)))
        .all()
        .sort((a, b) => (a.severity === b.severity ? a.id - b.id : a.severity === "panic" ? -1 : 1))
        .map(toEvent);
}

/** Mark one delivery acked. False when there was nothing to ack for this consumer. */
export function ackSignal(signalId: number, consumer: string, now: string = nowIso()): boolean {
    const r = getDb().update(schema.signalDeliveries)
        .set({ ackedAt: now })
        .where(and(
            eq(schema.signalDeliveries.signalId, signalId),
            eq(schema.signalDeliveries.recipient, consumer),
            isNull(schema.signalDeliveries.ackedAt),
        ))
        .run();
    return r.changes > 0;
}
