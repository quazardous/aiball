/**
 * #3909 — when a ticket last MOVED, for whoever waits on it with
 * `resume_on: { ticket }`.
 *
 * It is the ticket's last action (`last_actor_at`), with one kind left out: a
 * step (`then: continue`) that cites no commit. Such a step only re-parks the
 * ticket — same holder, still waiting — and counting it woke every ticket
 * parked on this one, whose own re-parks then woke the tickets parked on them
 * (helios: one note on a ticket, seven wakes, none of them with news). A step
 * that cites a commit delivered work, and still counts.
 *
 * The wakes (`ownFreshSteps`) and the cycle check (`liveResumeOn`) both read
 * this, so they agree on what "moved" means.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "../schema.js";
import { replayLastActor } from "./last-actor-gate.js";
import { isStepMeta } from "../ticket-transitions.js";

/** A step that delivered nothing: it keeps its ticket parked, nothing else. */
export function isParkingStep(kind: string, meta: string | null | undefined): boolean {
    if (kind !== "comment_added" || !isStepMeta(meta)) return false;
    try {
        const commits = (JSON.parse(meta!) as { commits?: unknown }).commits;
        return !Array.isArray(commits) || commits.length === 0;
    } catch {
        return true;
    }
}

/** When `ticketId` last moved (ISO), or null for an unknown ticket. */
export function lastMoveAt(ticketId: number): string | null {
    const db = getDb();
    const t = db.select({ by: schema.tickets.byAgent, createdAt: schema.tickets.createdAt, lastActorAt: schema.tickets.lastActorAt })
        .from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
    if (!t) return null;
    if (!t.lastActorAt) return t.createdAt;
    // The common case costs one lookup: the last action is not a parking step.
    const last = db.select({ kind: schema.messages.kind, meta: schema.messages.meta }).from(schema.messages).where(and(
        eq(schema.messages.ticketId, ticketId),
        eq(schema.messages.createdAt, t.lastActorAt),
    )).all();
    if (!last.some((m) => isParkingStep(m.kind, m.meta))) return t.lastActorAt;
    // Otherwise, the last action once the parking steps are left out.
    const events = db.select({
        byAgent: schema.messages.byAgent,
        createdAt: schema.messages.createdAt,
        kind: schema.messages.kind,
        meta: schema.messages.meta,
    }).from(schema.messages).where(eq(schema.messages.ticketId, ticketId)).all()
        .filter((m) => !isParkingStep(m.kind, m.meta));
    return replayLastActor({ actor: t.by ?? null, at: t.createdAt }, events).at;
}
