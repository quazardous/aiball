/**
 * #4698 — what a loop keeps of its Claude ending, so a death can be read after
 * the restart: the last lines of the screen it left, and the previous loop's
 * log, kept beside the new one (`loop.log.prev`) instead of going with the
 * state dir the start clears.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The screen's last non-blank lines, for a log line. */
export function screenTail(text: string, lines = 15): string {
    const kept = text.split("\n").map((l) => l.trimEnd());
    while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
    return kept.slice(-lines).join("\n");
}

/** At most this much of the previous log is kept: its end, where the death is. */
const PREVIOUS_LOG_MAX = 4 * 1024 * 1024;

/** Read the end of a state dir's `loop.log` before the dir is cleared; null without one. */
export function takePreviousLog(stateDir: string): string | null {
    const file = join(stateDir, "loop.log");
    try {
        if (!existsSync(file)) return null;
        const size = statSync(file).size;
        const text = readFileSync(file, "utf8");
        return size > PREVIOUS_LOG_MAX ? text.slice(-PREVIOUS_LOG_MAX) : text;
    } catch {
        return null;
    }
}

/** Put it back in the new state dir, as `loop.log.prev`. */
export function keepPreviousLog(stateDir: string, text: string | null): void {
    if (text === null) return;
    try { writeFileSync(join(stateDir, "loop.log.prev"), text); } catch { /* best effort: a trace, not the start */ }
}
