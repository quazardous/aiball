/**
 * The human's attention, extrapolated from the traces it leaves (#4088).
 *
 * Typing is the only part anything records directly. Each recorded act — a
 * prompt, a comment, a decision, a burst of keys — is taken as the visible tip
 * of a longer stretch of attention:
 *
 *   [switch][read what prompted it][type it] ● [watch what follows]
 *
 * - switch: a fixed cost when the act lands on another project than the one
 *   before, or after a long gap (finding the window, recalling the context);
 * - read: the text that came in since the human's previous act on that project,
 *   at a reading speed, capped (nobody reads hours of agent output);
 * - type: the act's own text, at a typing speed;
 * - watch: a while after it, until the next act at the latest.
 *
 * The stretches are laid on one timeline. Where two overlap, the later one
 * takes over from its start: one human, one project at a time. Each parameter
 * is an assumption, so the model runs three times (low, median, high) and the
 * report gives a range rather than one falsely exact number.
 *
 * Pure: no I/O. The sources live in attention-sources.ts.
 */

export type ActKind = "prompt" | "comment" | "decision" | "ticket" | "close" | "keys" | "relay";

export interface Act {
    /** Epoch ms. */
    at: number;
    project: string;
    kind: ActKind;
    /** Characters that came in and had to be read before the act. */
    readChars: number;
    /** Characters the human wrote. */
    typeChars: number;
}

export interface AttentionParams {
    /** Reading speed, characters per second. */
    readCps: number;
    /** Typing speed, characters per second. */
    typeCps: number;
    /** The cost of changing project, or of coming back after `gapSec`. */
    switchSec: number;
    /** A pause longer than this is a return, and costs a switch. */
    gapSec: number;
    /** Watching after an act, cut short by the next one. */
    watchSec: number;
    /** The most one act's reading can take. */
    maxReadSec: number;
}

/**
 * The three runs. Assumptions, written down so they can be argued with:
 * - reading: 250 wpm (~20 cps) for a skim, 180 wpm (~15 cps) for a read, 120 wpm
 *   (~10 cps) for a careful one (agent output is dense, often code);
 * - typing: 60 / 45 / 30 wpm (~6 / 4 / 3 cps), prompts in a second language included;
 * - a project switch: 20 s / 1 min / 2 min to find the window and the thread;
 * - watching after an act: 30 s / 2 min / 5 min.
 */
export const PARAM_SETS: Record<"low" | "median" | "high", AttentionParams> = {
    low: { readCps: 20, typeCps: 6, switchSec: 20, gapSec: 900, watchSec: 30, maxReadSec: 300 },
    median: { readCps: 15, typeCps: 4, switchSec: 60, gapSec: 900, watchSec: 120, maxReadSec: 600 },
    high: { readCps: 10, typeCps: 3, switchSec: 120, gapSec: 900, watchSec: 300, maxReadSec: 900 },
};

export interface Stretch {
    start: number;
    end: number;
    project: string;
}

/** One stretch of attention per act, before the timeline resolves overlaps. */
export function stretches(acts: readonly Act[], p: AttentionParams): Stretch[] {
    const sorted = [...acts].sort((a, b) => a.at - b.at);
    const out: Stretch[] = [];
    let prev: Act | undefined;
    for (const a of sorted) {
        const switched = !prev || prev.project !== a.project || a.at - prev.at > p.gapSec * 1000;
        const read = Math.min(a.readChars / p.readCps, p.maxReadSec);
        const type = a.typeChars / p.typeCps;
        const before = (switched ? p.switchSec : 0) + read + type;
        out.push({ start: a.at - before * 1000, end: a.at + p.watchSec * 1000, project: a.project });
        prev = a;
    }
    return out;
}

/**
 * Lay the stretches on one timeline: sorted by start, each runs until the next
 * one starts at the latest. A stretch that outlasts a shorter, later one does
 * not resume after it — a small undercount, accepted for a model this coarse.
 */
export function timeline(all: readonly Stretch[]): Stretch[] {
    const sorted = [...all].sort((a, b) => a.start - b.start);
    const out: Stretch[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const next = sorted[i + 1];
        const start = out.length ? Math.max(s.start, out[out.length - 1].end) : s.start;
        const end = next ? Math.min(s.end, Math.max(next.start, start)) : s.end;
        if (end > start) out.push({ start, end, project: s.project });
    }
    return out;
}

/** The local calendar day of an instant, as YYYY-MM-DD, in `timeZone`. */
export function dayOf(ms: number, timeZone?: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Hours per day per project, splitting stretches at local midnight. */
export function hoursByDay(line: readonly Stretch[], timeZone?: string): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    const add = (day: string, project: string, ms: number) => {
        const row = out.get(day) ?? new Map<string, number>();
        row.set(project, (row.get(project) ?? 0) + ms / 3_600_000);
        out.set(day, row);
    };
    for (const s of line) {
        let t = s.start;
        while (t < s.end) {
            const day = dayOf(t, timeZone);
            // The next local midnight: step an hour at a time until the day changes
            // (DST-safe without a calendar library), then back to its first minute.
            let cut = Math.min(s.end, t + 3_600_000);
            while (cut < s.end && dayOf(cut, timeZone) === day) cut = Math.min(s.end, cut + 3_600_000);
            if (dayOf(cut, timeZone) !== day) {
                let lo = t, hi = cut;
                while (hi - lo > 1000) {
                    const mid = Math.floor((lo + hi) / 2);
                    if (dayOf(mid, timeZone) === day) lo = mid; else hi = mid;
                }
                cut = hi;
            }
            add(day, s.project, cut - t);
            t = cut;
        }
    }
    return out;
}

/** The whole model for one parameter set. */
export function estimate(acts: readonly Act[], p: AttentionParams, timeZone?: string): Map<string, Map<string, number>> {
    return hoursByDay(timeline(stretches(acts, p)), timeZone);
}
