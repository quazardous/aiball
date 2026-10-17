/**
 * The human's attention, extrapolated from the traces it leaves (#4088).
 *
 * A snap model. Each recorded act — a prompt, a comment, a decision, a burst
 * of keys — is a point in time. Acts close to one another snap together into
 * one continuous period of work: the human was there between them, reading,
 * watching, thinking, even where nothing was recorded. A period opens a little
 * before its first act (getting into it) and closes a little after its last
 * (reading what came back):
 *
 *   ─[lead]─●──●─●───────●──●─[tail]─        ●─[…]
 *            gaps ≤ snap: one period          gap > snap: a new period
 *
 * A period is then shared among the projects worked on in it, in proportion
 * to a weight:
 * - `acts` (the default): the human's acts on each project;
 * - `tokens`: what each project's Claude sessions spent in that period, which
 *   says where the work actually went (a period with no tokens falls back to
 *   acts).
 *
 * Each parameter is an assumption, so the model runs three times (low,
 * median, high) and the report can show the range rather than one falsely
 * exact number.
 *
 * Pure: no I/O. The sources live in attention-sources.ts.
 */

export type ActKind = "prompt" | "comment" | "decision" | "ticket" | "close" | "keys" | "relay" | "ui";

export interface Act {
    /** Epoch ms. */
    at: number;
    project: string;
    kind: ActKind;
    /** The ticket the act was on, when the source says (the board, the UI log). */
    ticket?: number;
}

/** Tokens a project's Claude sessions spent at an instant (one assistant message). */
export interface Spend {
    at: number;
    project: string;
    tokens: number;
}

export interface AttentionParams {
    /** Two acts at most this far apart belong to the same period. */
    snapSec: number;
    /** A period opens this long before its first act. */
    leadSec: number;
    /** A period closes this long after its last act. */
    tailSec: number;
}

/**
 * The three runs. Assumptions, written down so they can be argued with:
 * - snap: 5 / 10 / 20 min — a pause shorter than this is still the same work
 *   (reading an answer, waiting on an agent, checking the board);
 * - lead: 1 / 3 / 5 min — getting into it before the first act (reading what
 *   prompted it, finding the window);
 * - tail: 1 / 5 / 10 min — after the last act, reading what came back.
 */
export const PARAM_SETS: Record<"low" | "median" | "high", AttentionParams> = {
    low: { snapSec: 300, leadSec: 60, tailSec: 60 },
    median: { snapSec: 600, leadSec: 180, tailSec: 300 },
    high: { snapSec: 1200, leadSec: 300, tailSec: 600 },
};

export type Weight = "acts" | "tokens";

export interface Period {
    start: number;
    end: number;
    /** Each project's share of the period, summing to 1. */
    shares: Map<string, number>;
}

/**
 * A ticket an agent files is usually one a human asked for, while watching: a
 * trace of the human too. But an agent working on its own files tickets as
 * well (sub-tickets in the night), so one counts only next to a human act:
 * within `windowMs` of one, before or after. It then lengthens a period the
 * human was in; it never makes one up.
 */
export function supervisedOnly(candidates: readonly Act[], human: readonly Act[], windowMs: number = 30 * 60_000): Act[] {
    const times = human.map((a) => a.at).sort((a, b) => a - b);
    const near = (t: number): boolean => {
        let lo = 0, hi = times.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
        return (lo < times.length && times[lo] - t <= windowMs) || (lo > 0 && t - times[lo - 1] <= windowMs);
    };
    return candidates.filter((c) => near(c.at));
}

/** Snap the acts into periods. */
export function periods(acts: readonly Act[], p: AttentionParams): Array<{ start: number; end: number; acts: Act[] }> {
    const sorted = [...acts].sort((a, b) => a.at - b.at);
    const out: Array<{ start: number; end: number; acts: Act[] }> = [];
    for (const a of sorted) {
        const cur = out[out.length - 1];
        if (cur && a.at - cur.acts[cur.acts.length - 1].at <= p.snapSec * 1000) {
            cur.acts.push(a);
            cur.end = a.at + p.tailSec * 1000;
        } else {
            out.push({ start: a.at - p.leadSec * 1000, end: a.at + p.tailSec * 1000, acts: [a] });
        }
    }
    // A lead may reach back into the previous period's tail: the time counts once.
    for (let i = 1; i < out.length; i++) out[i].start = Math.max(out[i].start, out[i - 1].end);
    return out;
}

/** Normalise a weight map to shares summing to 1; empty when it weighs nothing. */
function shares(w: Map<string, number>): Map<string, number> {
    const total = [...w.values()].reduce((a, b) => a + b, 0);
    return total > 0 ? new Map([...w].map(([k, v]) => [k, v / total])) : new Map();
}

/** The periods, each with its projects' shares. */
export function sharedPeriods(acts: readonly Act[], p: AttentionParams, weight: Weight = "acts", spend: readonly Spend[] = []): Period[] {
    const spends = [...spend].sort((a, b) => a.at - b.at);
    return periods(acts, p).map((per) => {
        const byActs = new Map<string, number>();
        for (const a of per.acts) byActs.set(a.project, (byActs.get(a.project) ?? 0) + 1);
        let s = shares(byActs);
        if (weight === "tokens") {
            const byTokens = new Map<string, number>();
            for (const x of spends) {
                if (x.at < per.start) continue;
                if (x.at > per.end) break;
                byTokens.set(x.project, (byTokens.get(x.project) ?? 0) + x.tokens);
            }
            const t = shares(byTokens);
            if (t.size) s = t;
        }
        return { start: per.start, end: per.end, shares: s };
    });
}

/** The local calendar day of an instant, as YYYY-MM-DD, in `timeZone`. */
export function dayOf(ms: number, timeZone?: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** The next instant after `t` that falls on another local day (to the second). */
function nextDayStart(t: number, timeZone?: string): number {
    const day = dayOf(t, timeZone);
    let hi = t + 3_600_000;
    while (dayOf(hi, timeZone) === day) hi += 3_600_000;
    let lo = t;
    while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (dayOf(mid, timeZone) === day) lo = mid; else hi = mid;
    }
    return hi;
}

/** Hours per day per project: each period split at local midnight, then shared. */
export function hoursByDay(list: readonly Period[], timeZone?: string): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const per of list) {
        let t = per.start;
        while (t < per.end) {
            const cut = Math.min(per.end, nextDayStart(t, timeZone));
            const day = dayOf(t, timeZone);
            const row = out.get(day) ?? new Map<string, number>();
            for (const [project, share] of per.shares) row.set(project, (row.get(project) ?? 0) + share * (cut - t) / 3_600_000);
            out.set(day, row);
            t = cut;
        }
    }
    return out;
}

/** The whole model for one parameter set. */
export function estimate(acts: readonly Act[], p: AttentionParams, opts: { weight?: Weight; spend?: readonly Spend[]; timeZone?: string } = {}): Map<string, Map<string, number>> {
    return hoursByDay(sharedPeriods(acts, p, opts.weight, opts.spend), opts.timeZone);
}

/** Hours per day per project, as `estimate` returns them. */
export type Hours = Map<string, Map<string, number>>;

/** Acts whose source outlives Claude's transcripts: the board and the UI log. */
export const DURABLE_KINDS: ReadonlySet<ActKind> = new Set(["comment", "decision", "ticket", "close", "relay", "ui"]);

export interface Calibration {
    /** Per project: full hours / durable hours over the training days. */
    perProject: Map<string, number>;
    /** The same over every project, for those too thin to have their own. */
    global: number;
    /** The training days. */
    days: string[];
}

const sumOver = (t: Hours, days: readonly string[], project?: string): number =>
    days.reduce((n, d) => n + (project ? t.get(d)?.get(project) ?? 0 : [...(t.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)), 0);

/**
 * #4091 — learn, on the days where every source exists, how much the durable
 * sources alone underestimate: a factor per project. A project with less than
 * `minHours` of durable time in the window takes the global factor.
 */
export function calibrate(full: Hours, durable: Hours, days: readonly string[], minHours = 1): Calibration {
    const projects = new Set<string>();
    for (const d of days) for (const p of durable.get(d)?.keys() ?? []) projects.add(p);
    const g = sumOver(durable, days);
    const global = g > 0 ? sumOver(full, days) / g : 1;
    const perProject = new Map<string, number>();
    for (const p of projects) {
        const base = sumOver(durable, days, p);
        perProject.set(p, base >= minHours ? sumOver(full, days, p) / base : global);
    }
    return { perProject, global, days: [...days] };
}

/** #4091 — the days before the window: the durable estimate, times each project's factor. */
export function extrapolate(durable: Hours, cal: Calibration, days: readonly string[]): Hours {
    const out: Hours = new Map();
    for (const d of days) {
        const row = new Map<string, number>();
        for (const [p, h] of durable.get(d) ?? []) row.set(p, h * (cal.perProject.get(p) ?? cal.global));
        if (row.size) out.set(d, row);
    }
    return out;
}
