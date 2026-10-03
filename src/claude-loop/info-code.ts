/**
 * #3514 — the bar's transient info word as data, for a client that writes it
 * in its own language (tvty is translated): `retry 3` is `{ code: "retry",
 * attempt: 3 }`. Derived in one place from the word the loop already sets, so
 * every producer stays as it is; the word itself stays in `marker.info` for a
 * client that shows it raw, and as the fallback for `other`.
 */
import type { BarInfoCode } from "../agent-bar.js";

const PLAIN = new Set(["resuming", "compacting", "wait", "interrupted", "user"]);
const ERRORS: Record<string, string> = { "err:rate-limit": "rate_limit", "err:overloaded": "overloaded", "err:api": "api" };

/** The code of an info word; `other` for a word this list does not know, null for none. */
export function infoCodeOf(info: string | null | undefined): BarInfoCode | null {
    if (!info) return null;
    if (PLAIN.has(info)) return { code: info };
    if (info === "picker:session" || info === "picker:mode") return { code: "picker", which: info.slice("picker:".length) };
    if (ERRORS[info]) return { code: "error", kind: ERRORS[info]! };
    const retry = /^retry (\d+)$/.exec(info);
    if (retry) return { code: "retry", attempt: Number(retry[1]) };
    return { code: "other" };
}
