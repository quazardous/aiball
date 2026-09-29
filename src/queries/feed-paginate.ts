/**
 * #396 (david h4gp5z): pagination + ordering for the full ticket thread feed.
 *
 * Pure, dependency-free so it unit-tests without spinning up the router / DB.
 * `asc` = top_down / oldest-first (the natural store order, default); `desc` =
 * bottom_up / newest-first, so `order=desc` + `limit=N` yields the N most recent
 * entries. Backward-compatible: with no offset/limit and order=asc the feed is
 * returned untouched and `pagination` is omitted (callers ship the full thread
 * exactly as before).
 */
export interface FeedPagination {
    offset: number;
    limit: number | null;
    returned: number;
    total: number;
    order: "asc" | "desc";
    has_more: boolean;
}

/** Query params come off Express `req.query` as `unknown` (string | string[]). */
export interface FeedPageQuery {
    offset?: unknown;
    limit?: unknown;
    order?: unknown;
}

function parsePositiveInt(v: unknown): number | null {
    if (typeof v !== "string") return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function paginateFeed<T>(feed: T[], q: FeedPageQuery): { feed: T[]; pagination?: FeedPagination } {
    const total = feed.length;
    const order: "asc" | "desc" = q.order === "desc" ? "desc" : "asc";
    const offset = parsePositiveInt(q.offset) ?? 0;
    const limit = parsePositiveInt(q.limit);
    // No-op fast path → exact pre-#396 behaviour, no pagination block.
    if (order === "asc" && offset === 0 && limit === null) return { feed };
    const ordered = order === "desc" ? [...feed].reverse() : feed;
    const sliced = limit !== null ? ordered.slice(offset, offset + limit) : ordered.slice(offset);
    return {
        feed: sliced,
        pagination: {
            offset,
            limit,
            returned: sliced.length,
            total,
            order,
            has_more: offset + sliced.length < total,
        },
    };
}
