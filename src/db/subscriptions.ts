/**
 * Subscriptions — project-level (cursor-based, role: owner / follower)
 * and ticket-level (per-thread ping fan-out). Also exposes
 * `ProjectStats` (lean counts surfaced by `ticket_new` to hint when
 * nobody is listening on a project).
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import type { Subscription, SubscriptionRole } from "./connection.js";

// =====================================================================
//  Project subscriptions
// =====================================================================

/**
 * Upsert a project subscription. If a row already exists and `role` is
 * provided, the role is updated to the new value (so an agent can promote
 * itself from follower to owner without unsubscribing first). Without an
 * explicit role argument the existing row is left untouched, and new rows
 * default to follower.
 */
export function upsertSubscription(
    consumer_id: string,
    project: string,
    role?: SubscriptionRole,
): Subscription {
    const db = getDb();
    const existing = db.select().from(schema.subscriptions)
        .where(and(
            eq(schema.subscriptions.consumerId, consumer_id),
            eq(schema.subscriptions.project, project),
        )).get();
    if (existing) {
        if (role && role !== existing.role) {
            db.update(schema.subscriptions)
                .set({ role })
                .where(and(
                    eq(schema.subscriptions.consumerId, consumer_id),
                    eq(schema.subscriptions.project, project),
                )).run();
            existing.role = role;
        }
        return {
            consumer_id: existing.consumerId,
            project: existing.project,
            subscribed_at: existing.subscribedAt,
            last_seen_id: existing.lastSeenId,
            role: (existing.role ?? "follower") as SubscriptionRole,
        };
    }
    db.insert(schema.subscriptions).values({
        consumerId: consumer_id,
        project,
        subscribedAt: nowIso(),
        lastSeenId: 0, // dormant, kept for column compat
        role: role ?? "follower",
    }).run();
    const fresh = db.select().from(schema.subscriptions)
        .where(and(
            eq(schema.subscriptions.consumerId, consumer_id),
            eq(schema.subscriptions.project, project),
        )).get();
    return {
        consumer_id: fresh!.consumerId,
        project: fresh!.project,
        subscribed_at: fresh!.subscribedAt,
        last_seen_id: fresh!.lastSeenId,
        role: (fresh!.role ?? "follower") as SubscriptionRole,
    };
}

export function deleteSubscription(consumer_id: string, project: string): void {
    getDb().delete(schema.subscriptions).where(and(
        eq(schema.subscriptions.consumerId, consumer_id),
        eq(schema.subscriptions.project, project),
    )).run();
}

export function listSubscriptions(consumer_id?: string): Subscription[] {
    const db = getDb();
    let q = db.select().from(schema.subscriptions).$dynamic();
    if (consumer_id) q = q.where(eq(schema.subscriptions.consumerId, consumer_id));
    return q.orderBy(asc(schema.subscriptions.consumerId), asc(schema.subscriptions.project))
        .all()
        .map((r) => ({
            consumer_id: r.consumerId,
            project: r.project,
            subscribed_at: r.subscribedAt,
            last_seen_id: r.lastSeenId,
            role: (r.role ?? "follower") as SubscriptionRole,
        }));
}

/**
 * Project subscribers, optionally filtered by role. Without filter you get
 * everyone; with `roles: ["owner"]` only the project maintainers; with
 * `roles: ["follower"]` only the broadcast-only subscribers.
 *
 * fanOutPings uses this to send broadcast tickets to everyone but keep
 * internal-only tickets visible to owners only.
 */
export function listProjectSubscribers(
    project: string,
    opts: { roles?: SubscriptionRole[] } = {},
): string[] {
    const db = getDb();
    const filters = [eq(schema.subscriptions.project, project)];
    if (opts.roles && opts.roles.length > 0) {
        filters.push(inArray(schema.subscriptions.role, opts.roles));
    }
    return db.select({ consumer_id: schema.subscriptions.consumerId })
        .from(schema.subscriptions)
        .where(and(...filters))
        .all()
        .map((r) => r.consumer_id);
}

/**
 * Lean per-project stats used by `ticket_new` to surface subscriber
 * counts in the response (« nobody is listening » hint per #B.215).
 * Cheap enough to fire on every post — three indexed SUMs.
 */
export interface ProjectStats {
    project: string;
    owners: number;
    followers: number;
    ticket_count: number;
    comment_count: number;
}

export function getProjectStats(project: string): ProjectStats {
    const db = getDb();
    const subs = db.select({
        owners: sql<number>`SUM(CASE WHEN ${schema.subscriptions.role} = 'owner' THEN 1 ELSE 0 END)`,
        followers: sql<number>`SUM(CASE WHEN ${schema.subscriptions.role} = 'follower' THEN 1 ELSE 0 END)`,
    }).from(schema.subscriptions)
        .where(eq(schema.subscriptions.project, project))
        .get();
    const tickets = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.tickets)
        .where(eq(schema.tickets.project, project))
        .get();
    const comments = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.messages.kind, "comment_added"),
        ))
        .get();
    return {
        project,
        owners: Number(subs?.owners ?? 0),
        followers: Number(subs?.followers ?? 0),
        ticket_count: Number(tickets?.n ?? 0),
        comment_count: Number(comments?.n ?? 0),
    };
}

// =====================================================================
//  Ticket subscriptions (per-thread follow)
// =====================================================================

export function upsertTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb().insert(schema.ticketSubscriptions).values({
        consumerId: consumer_id,
        ticketId: ticket_id,
        subscribedAt: nowIso(),
    }).onConflictDoNothing().run();
}

export function deleteTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb().delete(schema.ticketSubscriptions).where(and(
        eq(schema.ticketSubscriptions.consumerId, consumer_id),
        eq(schema.ticketSubscriptions.ticketId, ticket_id),
    )).run();
}

export function listTicketSubscribers(ticket_id: number): string[] {
    return getDb().select({ consumer_id: schema.ticketSubscriptions.consumerId })
        .from(schema.ticketSubscriptions)
        .where(eq(schema.ticketSubscriptions.ticketId, ticket_id))
        .all()
        .map((r) => r.consumer_id);
}

export function listTicketSubscriptions(consumer_id: string): {
    ticket_id: number;
    subscribed_at: string;
}[] {
    return getDb().select({
        ticket_id: schema.ticketSubscriptions.ticketId,
        subscribed_at: schema.ticketSubscriptions.subscribedAt,
    })
        .from(schema.ticketSubscriptions)
        .where(eq(schema.ticketSubscriptions.consumerId, consumer_id))
        .orderBy(desc(schema.ticketSubscriptions.subscribedAt))
        .all();
}
