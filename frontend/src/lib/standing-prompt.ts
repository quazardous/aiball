/**
 * #1832 — the recall list behind the per-project standing instruction.
 *
 * Browser-side on david's call: it is a typing convenience, not data. It never
 * needs to reach the daemon, survive a reinstall, or be read by an agent. The
 * trade, stated once: it does not follow to another device, and clearing site
 * data forgets it.
 *
 * Extracted here because the instruction is now editable from two places — the
 * project settings page and the header popover. Two copies of a storage key
 * and a dedup rule would drift, and the drift would show up as suggestions
 * that exist in one place and not the other.
 */
const HISTORY_KEY = "aiball.standingPrompt.history";
const HISTORY_MAX = 12;

function keyFor(project: string): string {
    return `${HISTORY_KEY}.${project}`;
}

/** Newest first. Empty on any storage failure — a private window, cleared
 *  site data, or a browser refusing it. The field still works; it just stops
 *  suggesting, which is the right way for a convenience to degrade. */
export function readStandingPromptHistory(project: string): string[] {
    try {
        const raw = localStorage.getItem(keyFor(project));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Remember one entry: newest first, deduplicated, bounded.
 *
 * Clearing the FIELD must never clear the history — the whole point is to type
 * a recurring instruction once and pick it back on the next departure. So an
 * empty value is a no-op here rather than a reset.
 */
export function rememberStandingPrompt(project: string, value: string): string[] {
    const v = value.trim();
    const current = readStandingPromptHistory(project);
    if (!v) return current;
    const next = [v, ...current.filter((h) => h !== v)].slice(0, HISTORY_MAX);
    try {
        localStorage.setItem(keyFor(project), JSON.stringify(next));
    } catch { /* storage refused — suggestions are optional */ }
    return next;
}
