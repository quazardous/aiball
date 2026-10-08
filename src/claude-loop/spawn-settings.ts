import type { StatusLineSetting } from "./usage.js";

/**
 * #2201 — the settings object claude-loop hands to `claude --settings` at spawn.
 *
 * Pure, so the composition can be tested without spawning anything. The hook
 * wiring (always), and the agent's tool denials (only when its tree declares
 * some). A tree that declares none gets no `permissions` key at all, so its
 * session starts exactly as it did before this existed — an empty deny block
 * is not written "just in case".
 *
 * Deny rules win over allow rules in Claude Code, including the user's own
 * settings: checked against the real binary, a `Read` denied here stays denied.
 *
 * #3686 — and the loop's status line, when given: it reads the subscription's
 * usage and runs the user's own (see `usage.ts`).
 */
export function buildSpawnSettings<H>(hooks: H, denyTools: readonly string[], statusLine?: StatusLineSetting) {
    return {
        hooks,
        ...(denyTools.length > 0 ? { permissions: { deny: [...denyTools] } } : {}),
        ...(statusLine ? { statusLine } : {}),
    };
}
