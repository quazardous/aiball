/**
 * #1819 — the two FACTS an agent needs to judge whether a human is around,
 * and deliberately no verdict built from them.
 *
 * The ticket asked for an explicit "the human is absent" state. Both the
 * reporter and I landed on the same objection from opposite directions: a
 * boolean forces the threshold into this code, for every agent and every
 * gesture, when the threshold depends on what is about to be committed —
 * three minutes is enough to decide a rename, not a refactor. And "absent" is
 * wrong in both directions in the regime that turns out to be the most common:
 * david present but not in front, answering in thirty seconds then vanishing
 * for an hour, in one session, announcing nothing.
 *
 * So this returns elapsed time and lets the caller pick its own line. It is
 * also the more honest shape: we know when the last message arrived; we do not
 * know whether he went to eat or shut the laptop.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

/**
 * Seconds since `iso`, or null when there is nothing to measure.
 *
 * Null means "never seen", which a caller must not confuse with "a long time
 * ago" — the two lead to opposite decisions. Clamped at zero so a clock skew
 * between the daemon and a loop surfaces as "just now" rather than as a
 * negative number that every `age < threshold` comparison would mis-read.
 */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.round((nowMs - t) / 1000));
}

export interface PresenceFacts {
    /** ISO timestamp of the newest message authored by a HUMAN consumer, or
     *  null when none exists in scope. */
    last_human_message_at: string | null;
    /** Seconds since that message. Null when there is none — which means
     *  "never seen", NOT "a long time ago". */
    last_human_message_age_sec: number | null;
    /** The loop's own view, pushed on each state heartbeat. `word` is the
     *  four-value presence (`stop` / `boot` / `wait` / `loop`); `at` is when
     *  the heartbeat last landed. */
    loop_presence_word: string | null;
    loop_human_flag: boolean | null;
    loop_state_age_sec: number | null;
}

/**
 * `project` scopes the human-message lookup; omit for cross-project.
 * `consumerId` is the caller, whose own row carries the loop-pushed state.
 *
 * Every field degrades to null rather than to a guess. A stale heartbeat means
 * UNKNOWN, not absent — without `loop_state_age_sec` a caller would read a
 * dead timer as a departed human, which is the same mistake in a new place.
 */
export function getPresenceFacts(consumerId: string, project?: string): PresenceFacts {
    const db = getDb();
    const nowMs = Date.now();
    const age = (iso: string | null): number | null => ageSeconds(iso, nowMs);

    const humans = db.select({ id: schema.consumers.consumerId })
        .from(schema.consumers)
        .where(eq(schema.consumers.kind, "human"))
        .all()
        .map((r) => r.id);

    let lastAt: string | null = null;
    if (humans.length > 0) {
        // `_messages` carries no project of its own — it hangs off a ticket,
        // and the ticket holds the project. So scoping means a join.
        const q = db.select({ createdAt: schema.messages.createdAt })
            .from(schema.messages)
            .innerJoin(schema.tickets, eq(schema.messages.ticketId, schema.tickets.id))
            .where(and(
                isNotNull(schema.messages.byAgent),
                inArray(schema.messages.byAgent, humans),
                ...(project ? [eq(schema.tickets.project, project)] : []),
            ))
            .orderBy(desc(schema.messages.createdAt))
            .limit(1);
        const row = q.get();
        lastAt = row?.createdAt ?? null;
    }

    const me = db.select().from(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumerId))
        .get();

    return {
        last_human_message_at: lastAt,
        last_human_message_age_sec: age(lastAt),
        loop_presence_word: (me?.stateHumanWord as string | null) ?? null,
        loop_human_flag: me?.stateHuman == null ? null : me.stateHuman === 1,
        loop_state_age_sec: age(me?.stateUpdatedAt ?? null),
    };
}
