/**
 * #594 — single-shot loop name format : `cl-<project>-<hash6>` where
 * `hash6 = sha256(canonicalCwd + ':' + agent).slice(0, 6)`.
 *
 * Stable (same cwd + agent → same hash → same loop retrieved), distinct
 * by default (no fallback chain), aligned with `tmuxName` (identity) +
 * `stateDirFor` (uses the name as-is) so the 3 derived strings match.
 *
 * Older loops (pre-#594) carry the legacy `cl-<project>` shape ; voie A
 * migration (david `nndjjb`) — no rename, the legacy loops survive until
 * `claude-loop rm` and the next start uses the new format.
 *
 * #3338 — from the start's resolved context only: its folder is the one the
 * loop runs in and its plate records (`--cwd`, else `AIBALL_CWD`, else the
 * shell's). Named after the shell's folder, a start from a shell carrying
 * another folder's AIBALL_CWD gave the agent a second loop under another name.
 */
import { createHash } from "node:crypto";
import { canonicalCwd } from "./state.js";

export function loopName(ctx: { project?: string | null; agent?: string | null; cwd: string }): string {
    const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const p = ctx.project ? slug(ctx.project) : "loop";
    const hash = createHash("sha256").update(`${canonicalCwd(ctx.cwd)}:${ctx.agent ?? ""}`).digest("hex").slice(0, 6);
    return `cl-${p}-${hash}`;
}
