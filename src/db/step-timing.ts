/**
 * #2629 — how well agents judge `continue_after_minutes`.
 *
 * david: « les agents ont la main lourde … comment faire pour qu'ils
 * sous-évaluent plutôt que surévaluent ? ». The wording now asks for the
 * soonest a look is worth it; this is the indicator that says whether it moved
 * anything. For every step with a delay, compare the delay declared with when
 * the same agent next spoke on that ticket.
 *
 * What it can NOT say: when the job actually finished. Coming back early may be
 * an event, a human, or the agent itself; coming back late may be a busy agent.
 * It is a trend to watch before and after a change, not a verdict on one step.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";

export interface StepTimingRow {
    declared_minutes: number;
    /** Minutes until the same agent next spoke on the ticket; null = not yet. */
    actual_minutes: number | null;
}

export const STEP_TIMING_BUCKETS = [
    { label: "1-15", max: 15 },
    { label: "16-30", max: 30 },
    { label: "31-60", max: 60 },
    { label: "61+", max: Number.POSITIVE_INFINITY },
] as const;

export interface StepTimingBucket {
    bucket: string;
    steps: number;
    avg_declared: number;
    /** Back before half the declared delay. */
    early: number;
    /** Back between half and 1.1× the declared delay. */
    on_time: number;
    /** Back after 1.1× the declared delay. */
    late: number;
    /** Not back yet. */
    pending: number;
}

/** Pure: rows → one line per bucket; delays of 0 (carry on at once) are left out. */
export function stepTimingReport(rows: StepTimingRow[]): StepTimingBucket[] {
    return STEP_TIMING_BUCKETS.map((b, i) => {
        const min = i === 0 ? 0 : STEP_TIMING_BUCKETS[i - 1].max;
        const inB = rows.filter((r) => r.declared_minutes > min && r.declared_minutes <= b.max);
        const back = inB.filter((r) => r.actual_minutes !== null) as Array<StepTimingRow & { actual_minutes: number }>;
        return {
            bucket: b.label,
            steps: inB.length,
            avg_declared: inB.length ? Math.round(inB.reduce((s, r) => s + r.declared_minutes, 0) / inB.length) : 0,
            early: back.filter((r) => r.actual_minutes < r.declared_minutes * 0.5).length,
            on_time: back.filter((r) => r.actual_minutes >= r.declared_minutes * 0.5 && r.actual_minutes <= r.declared_minutes * 1.1).length,
            late: back.filter((r) => r.actual_minutes > r.declared_minutes * 1.1).length,
            pending: inB.length - back.length,
        };
    });
}

export function stepTimingRows(opts: { project?: string | null; since?: string | null } = {}): StepTimingRow[] {
    const project = opts.project ?? null;
    const since = opts.since ?? null;
    const rows = getDb().all<{ declared: number; actual: number | null }>(sql`
        SELECT
            (julianday(json_extract(m.meta, '$.step_resume_at')) - julianday(m.created_at)) * 1440 AS declared,
            ((SELECT julianday(MIN(n.created_at)) FROM _messages n
               WHERE n.ticket_id = m.ticket_id AND n.id > m.id AND n.by_agent = m.by_agent)
             - julianday(m.created_at)) * 1440 AS actual
        FROM _messages m
        JOIN tickets t ON t.id = m.ticket_id
        WHERE json_extract(m.meta, '$.step') = 1
          AND json_extract(m.meta, '$.step_resume_at') IS NOT NULL
          AND (${project} IS NULL OR t.project = ${project})
          AND (${since} IS NULL OR m.created_at >= ${since})
    `);
    return rows
        .map((r) => ({ declared_minutes: Math.round(r.declared), actual_minutes: r.actual === null ? null : Math.round(r.actual) }))
        .filter((r) => r.declared_minutes > 0);
}
