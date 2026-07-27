/**
 * Pane decoration — the shared predicates for the noise Claude Code draws
 * around its own text (#1588).
 *
 * Every state detector in the loop matches text against a `capture-pane`
 * dump, and that dump is not clean text: the input box is drawn with
 * box-drawing rules, and those rules can carry a LABEL inside them. A real
 * capture of an aiball loop:
 *
 *     ────────────────────────…──────── claude-aiball-dev ──
 *     ❯
 *     ──────────────────────────────────────────────────────
 *       ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt
 *
 * The bottom rule is a pure run of `─`. The top one is not — and the rules
 * that asked for a pure run stopped seeing the box at all. Measured on 30
 * consecutive captures of a working loop: the chevron was there 30/30, a pure
 * rule was there 30/30, a LABELLED rule was there 30/30, and
 * `findPromptZone` — which required both to be pure — found the box 0/30.
 *
 * This module is a leaf on purpose: `error-backoff.ts` and
 * `pane-watchers/` both need it, and neither should import the other.
 */

/** Minimum run of `─` before we call a line a frame rule. Claude Code draws
 *  its boxes at terminal width, so a real rule is far longer; the threshold
 *  keeps short separators inside rendered conversation from matching. */
const MIN_RULE = 20;

/**
 * True for a line that OPENS with a long run of `─` — whether or not the run
 * is interrupted afterwards by a label, a corner, or trailing text.
 *
 * The prefix is the load-bearing part. Requiring the line to be *nothing but*
 * the run (`/^─{20,}$/`) is what broke: it accepts the undecorated bottom rule
 * and rejects the labelled top one, so any rule needing BOTH silently went
 * blind. A line that starts with twenty box-drawing characters is a rule; what
 * follows is decoration.
 */
export function isFrameRule(line: string): boolean {
    return new RegExp(`^\\s*─{${MIN_RULE},}`, "u").test(line);
}

/**
 * True for a line that is a user-prompt line (`>` / `❯` prefix).
 *
 * Split out of `footerOf` so the predicate has one definition. Note the
 * separator is not always an ASCII space: the empty Claude prompt renders as
 * `❯` + U+00A0, which `\s` does cover.
 */
export function isPromptLine(line: string): boolean {
    return /^[>❯]\s/u.test(line);
}
