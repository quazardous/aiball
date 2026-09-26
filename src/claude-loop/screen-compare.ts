/**
 * #3048 — is the proxy's screen model the screen tmux shows? Before anything
 * reads the screen from the proxy instead of `tmux capture-pane`, the kernel
 * compares the two on its own loop, now and then, and keeps the score. An
 * indicator only: no behaviour depends on it.
 *
 * Pure but for the score file (`<state_dir>/screen-compare.json`), which
 * `claude-loop health` reads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScreenReading {
    text: string;
    /** 0-based, visible-screen relative; null when unknown. */
    cursor: { x: number; y: number } | null;
}

export interface ScreenComparison {
    match: boolean;
    textMatch: boolean;
    /** null when either side has no cursor. */
    cursorMatch: boolean | null;
    diffLines: number;
    /** The first rows that differ (at most 3), for the log. */
    first: { row: number; tmux: string; proxy: string }[];
}

/** Both sides the same way: trailing spaces off each row, blank rows off the bottom. */
export function normalizeScreen(text: string): string[] {
    const rows = text.replace(/\r/g, "").split("\n").map((r) => r.trimEnd());
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows;
}

export function compareScreens(tmux: ScreenReading, proxy: ScreenReading): ScreenComparison {
    const a = normalizeScreen(tmux.text);
    const b = normalizeScreen(proxy.text);
    const first: ScreenComparison["first"] = [];
    let diffLines = 0;
    for (let row = 0; row < Math.max(a.length, b.length); row++) {
        const t = a[row] ?? "";
        const p = b[row] ?? "";
        if (t !== p) {
            diffLines++;
            if (first.length < 3) first.push({ row, tmux: t, proxy: p });
        }
    }
    const cursorMatch = tmux.cursor && proxy.cursor
        ? tmux.cursor.x === proxy.cursor.x && tmux.cursor.y === proxy.cursor.y
        : null;
    const textMatch = diffLines === 0;
    return { match: textMatch && cursorMatch !== false, textMatch, cursorMatch, diffLines, first };
}

export interface ScreenCompareScore {
    comparisons: number;
    mismatches: number;
    /** Skipped: the screen moved while it was read (two tmux reads differed). */
    unstable: number;
    last_at: string | null;
    last_mismatch: { at: string; diffLines: number; cursorMatch: boolean | null; first: ScreenComparison["first"] } | null;
}

export function screenComparePath(sd: string): string { return join(sd, "screen-compare.json"); }

const EMPTY: ScreenCompareScore = { comparisons: 0, mismatches: 0, unstable: 0, last_at: null, last_mismatch: null };

export function readScreenCompareScore(sd: string): ScreenCompareScore {
    try {
        return { ...EMPTY, ...(JSON.parse(readFileSync(screenComparePath(sd), "utf8")) as Partial<ScreenCompareScore>) };
    } catch {
        return { ...EMPTY };
    }
}

/** Add one reading to the score: a comparison (null = the screen moved, skipped). */
export function recordScreenComparison(sd: string, result: ScreenComparison | null, now: Date = new Date()): ScreenCompareScore {
    const score = readScreenCompareScore(sd);
    const at = now.toISOString();
    if (result === null) {
        score.unstable++;
    } else {
        score.comparisons++;
        score.last_at = at;
        if (!result.match) {
            score.mismatches++;
            score.last_mismatch = { at, diffLines: result.diffLines, cursorMatch: result.cursorMatch, first: result.first };
        }
    }
    try { writeFileSync(screenComparePath(sd), JSON.stringify(score)); } catch { /* best-effort: an indicator */ }
    return score;
}
