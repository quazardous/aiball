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
    muted = false,
): void {
    // #352: muted is part of the conflict update so toggling follow↔mute on an
    // existing row flips it (keeps the original subscribed_at).
    getDb().insert(schema.ticketSubscriptions).values({
        consumerId: consumer_id,
        ticketId: ticket_id,
        subscribedAt: nowIso(),
        muted: muted ? 1 : 0,
    }).onConflictDoUpdate({
        target: [schema.ticketSubscriptions.consumerId, schema.ticketSubscriptions.ticketId],
        set: { muted: muted ? 1 : 0 },
    }).run();
}

/**
 * #352: consumers who have explicitly MUTED this ticket (muted=1). The
 * fan-out subtracts these so a mute beats the project-owner / subscriber
 * role — the only way an owner can silence one thread.
 */
export function mutedConsumersForTicket(ticket_id: number): Set<string> {
    const rows = getDb().select({ consumer_id: schema.ticketSubscriptions.consumerId })
        .from(schema.ticketSubscriptions)
        .where(and(
            eq(schema.ticketSubscriptions.ticketId, ticket_id),
            eq(schema.ticketSubscriptions.muted, 1),
        ))
        .all();
    return new Set(rows.map((r) => r.consumer_id));
}

/**
 * #352: the current consumer's relationship to a ticket:
 *   - "muted"    — explicit mute row (suppresses pings even by role)
 *   - "followed" — explicit follow row
 *   - null       — no row (role-default applies)
 */
export function getTicketSubscriptionState(
    consumer_id: string,
    ticket_id: number,
): "followed" | "muted" | null {
    const row = getDb().select({ muted: schema.ticketSubscriptions.muted })
        .from(schema.ticketSubscriptions)
        .where(and(
            eq(schema.ticketSubscriptions.consumerId, consumer_id),
            eq(schema.ticketSubscriptions.ticketId, ticket_id),
        ))
        .get();
    if (!row) return null;
    return row.muted ? "muted" : "followed";
}

/**
 * #352: every EXPLICIT subscription on a ticket (one row per follow/mute),
 * for the moderator's inline manage panel. Owners pinged purely by project
 * role have no row here (david: "abonnement explicite uniquement").
 */
export function listTicketSubscriptionsForTicket(ticket_id: number): {
    consumer_id: string;
    muted: boolean;
    subscribed_at: string;
}[] {
    return getDb().select({
        consumer_id: schema.ticketSubscriptions.consumerId,
        muted: schema.ticketSubscriptions.muted,
        subscribed_at: schema.ticketSubscriptions.subscribedAt,
    })
        .from(schema.ticketSubscriptions)
        .where(eq(schema.ticketSubscriptions.ticketId, ticket_id))
        .orderBy(desc(schema.ticketSubscriptions.subscribedAt))
        .all()
        .map((r) => ({ consumer_id: r.consumer_id, muted: !!r.muted, subscribed_at: r.subscribed_at }));
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

/**
 * Distinct consumer_ids seen anywhere in the database (project
 * subscribers + ticket subscribers + ticket authors + message authors).
 * Used to seed the @-mention autocomplete in the composer (#B.71).
 */
export function listKnownAgents(): string[] {
    const db = getDb();
    const out = new Set<string>();
    for (const r of db.selectDistinct({ id: schema.subscriptions.consumerId })
        .from(schema.subscriptions).all()) {
        if (r.id) out.add(r.id);
    }
    for (const r of db.selectDistinct({ id: schema.ticketSubscriptions.consumerId })
        .from(schema.ticketSubscriptions).all()) {
        if (r.id) out.add(r.id);
    }
    for (const r of db.selectDistinct({ id: schema.tickets.byAgent })
        .from(schema.tickets).all()) {
        if (r.id) out.add(r.id);
    }
    for (const r of db.selectDistinct({ id: schema.messages.byAgent })
        .from(schema.messages).all()) {
        if (r.id) out.add(r.id);
    }
    return [...out].sort();
}
