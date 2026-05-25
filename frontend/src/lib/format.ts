/**
 * Pure presentation formatters. No state, no side-effects.
 *
 * Extracted from InboxList.vue (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type InboxRow, type TokenUsage } from "./api";

/**
 * #446 — token EFFORT: the genuinely NEW tokens a ticket consumed (input +
 * cache-writes + output). Excludes `cache_r` on purpose: cache reads are the
 * SAME conversation context re-read from cache on every turn (~the whole
 * prompt, e.g. ~240k each turn), so summing them across turns re-counts the
 * same context N times and inflates the tally — david's "cumule le cumul".
 * This is the headline figure shown in the UI. Returns 0 for a null tally.
 */
export function estTokenEffort(u: TokenUsage | null | undefined): number {
    if (!u) return 0;
    return (u.tokens_in ?? 0) + (u.cache_w ?? 0) + (u.tokens_out ?? 0);
}

/**
 * #404 — "cost-equivalent" token figure: effort PLUS the re-read context billed
 * at ~0.1× (cache reads are ~10× cheaper than fresh tokens). Kept for the
 * tooltips/cost view (#446 Hybrid): the cache-read component is real spend, but
 * it's shown SEPARATELY from the effort headline so the displayed number isn't
 * dominated by the same context re-read each turn. Returns 0 for a null tally.
 */
export function estTokenCost(u: TokenUsage | null | undefined): number {
    if (!u) return 0;
    return (u.tokens_in ?? 0) + (u.cache_w ?? 0) + (u.tokens_out ?? 0) + Math.round((u.cache_r ?? 0) * 0.1);
}

/**
 * #446 — shared tooltip for the token chip: the effort headline broken down,
 * then the re-read context shown apart with its ~0.1× cost-equivalent. Keeps
 * the four display sites (inbox row, thread header, projects, stats) consistent.
 */
export function tokenBreakdownTitle(u: TokenUsage | null | undefined): string {
    if (!u) return "";
    return `effort ${formatTokens(estTokenEffort(u))} tok — new tokens: in ${u.tokens_in} · out ${u.tokens_out} · cache-write ${u.cache_w}`
        + ` · context re-read (cache): ${formatTokens(u.cache_r)} — same context re-read each turn, billed ~0.1× → cost-equiv ~${formatTokens(estTokenCost(u))} tok`;
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
