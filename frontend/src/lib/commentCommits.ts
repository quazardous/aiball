/**
 * #2653 — the commits a comment said it delivers (`meta.commits`, #2652), as
 * the row of chips shown under the comment. Pure, so a Node test pins it.
 */
export interface CommentCommit {
    sha: string;
    minutes: number;
    reason: string | null;
}

export interface CommitChip {
    sha: string;
    short: string;
    /** "+2 min", or the reason it earned nothing. */
    credit: string;
    earned: boolean;
    title: string;
    url: string | null;
}

export type CommitsView =
    | { state: "absent" }
    | { state: "none" }
    | { state: "list"; chips: CommitChip[] };

export function commitsView(meta: string | null | undefined, commitUrl: (sha: string) => string | null): CommitsView {
    let m: { commits?: unknown } = {};
    try {
        m = meta ? JSON.parse(meta) as { commits?: unknown } : {};
    } catch {
        return { state: "absent" };
    }
    if (!m || typeof m !== "object" || !("commits" in m)) return { state: "absent" };
    if (m.commits === null) return { state: "none" };
    if (!Array.isArray(m.commits) || m.commits.length === 0) return { state: "none" };
    const chips = (m.commits as CommentCommit[])
        .filter((c) => c && typeof c.sha === "string")
        .map((c): CommitChip => {
            const earned = c.minutes > 0;
            const credit = earned ? `+${c.minutes} min` : (c.reason ?? "no credit");
            const url = commitUrl(c.sha);
            return {
                sha: c.sha,
                short: c.sha.slice(0, 7),
                credit,
                earned,
                title: `commit ${c.sha}${url ? "" : " — click to copy the SHA"}`,
                url,
            };
        });
    return chips.length ? { state: "list", chips } : { state: "none" };
}
