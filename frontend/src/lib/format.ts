/**
 * Pure presentation formatters. No state, no side-effects.
 *
 * Extracted from InboxList.vue (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type InboxRow } from "./api";

/**
 * Coarse relative time used in the inbox row. Buckets are picked for
 * scan-ability:
 *   < 1h    → "Nm ago"   (at least 1m, never 0m)
 *   < 1d    → "Nh ago"
 *   < 1w    → "Nd ago"
 *   older   → locale date string
 */
export function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

/** Inline snippet of a row — agent-authored summary (#B.87) takes
 *  priority, otherwise fall back to the body's first ~140 chars.
 *  Both flattened (whitespace collapsed). */
export function snippetOf(r: InboxRow): string {
    const raw = r.summary && r.summary.trim().length > 0 ? r.summary : (r.body ?? "");
    const flat = raw.replace(/\s+/g, " ").trim();
    return flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
}

/** Row title with a stable fallback so the layout doesn't jump. */
export function titleOf(r: InboxRow): string {
    return r.title ?? "(no title)";
}
