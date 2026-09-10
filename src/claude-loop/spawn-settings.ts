/**
 * #2201 — the settings object claude-loop hands to `claude --settings` at spawn.
 *
 * Pure, so the composition can be tested without spawning anything. Two parts:
 * the hook wiring (always), and the agent's tool denials (only when its tree
 * declares some). A tree that declares none gets no `permissions` key at all,
 * so its session starts exactly as it did before this existed — an empty deny
 * block is not written "just in case".
 *
 * Deny rules win over allow rules in Claude Code, including the user's own
 * settings: checked against the real binary, a `Read` denied here stays denied.
 */
export function buildSpawnSettings<H>(hooks: H, denyTools: readonly string[]) {
    return denyTools.length > 0
        ? { hooks, permissions: { deny: [...denyTools] } }
        : { hooks };
}
