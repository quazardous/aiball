/**
 * #3099 — run `fn` at most once every `ms`, the last call winning: a burst of
 * live events (about one a second on a busy board) becomes one re-read of the
 * page, not one each. The first call after a quiet spell runs at once.
 */
export function coalesce(fn: () => void, ms: number, now: () => number = Date.now): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = -Infinity;
    return () => {
        if (timer) return; // already due: this call is covered by it
        const wait = Math.max(0, last + ms - now());
        timer = setTimeout(() => {
            timer = null;
            last = now();
            fn();
        }, wait);
    };
}

/**
 * #3099 — the latest of several reads wins: a read answered after a newer one
 * was asked (the page of the project the user just left) is dropped.
 */
export function latestOnly() {
    let seq = 0;
    return {
        /** Mark a read as asked; the token says, when it answers, whether it is still the latest. */
        begin(): number { return ++seq; },
        isLatest(token: number): boolean { return token === seq; },
    };
}
