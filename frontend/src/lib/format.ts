/**
 * Pure presentation formatters. No state, no side-effects.
 *
 * Extracted from InboxList.vue (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type InboxRow, type TokenUsage } from "./api";

/**
 * #404 — single "cost-equivalent" token figure for a ticket's effort. Cache
 * reads are ~10× cheaper than fresh tokens, so they're weighted 0.1× (see the
 * #404 findings); input + cache-writes + output count full. Returns 0 for a
 * null/absent tally.
 */
export function estTokenCost(u: TokenUsage | null | undefined): number {
    if (!u) return 0;
    return (u.tokens_in ?? 0) + (u.cache_w ?? 0) + (u.tokens_out ?? 0) + Math.round((u.cache_r ?? 0) * 0.1);
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

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
