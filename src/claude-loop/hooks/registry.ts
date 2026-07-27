/**
 * Hook registry — the single declarative source of the Claude Code hooks a
 * loop installs. Adding or retuning a hook is one entry here, instead of
 * hand-editing the `settings.hooks` JSON in `cli.ts` (the old shape let a
 * matcher be silently forgotten — see the SessionStart `compact` note below).
 *
 * S1 generated `settings.hooks` from this table. S2 routes every event through
 * a single dispatcher script (`hook-entry.ts`) that dynamically imports the
 * event's handler module — so a new hook is a registry entry + a handler
 * module, never a new registered CLI script. The handler modules
 * (`stop-hook.ts`, …) are unchanged; they still run their logic on import.
 */

/** A single hook declaration. */
export interface HookSpec {
    /** Claude Code hook event name (e.g. "SessionStart", "Stop"). */
    event: string;
    /**
     * Matchers to register the handler against. Omit for events that take no
     * matcher (Stop, UserPromptSubmit) — a single matcher-less entry is emitted.
     */
    matchers?: string[];
    /**
     * Handler module, as an import specifier RELATIVE TO `hook-entry.ts`
     * (which lives in this `hooks/` dir). The dispatcher `await import()`s it;
     * the module runs its logic on import (they are side-effecting scripts).
     */
    module: string;
}

/** The single dispatcher script, repo-root-relative (used to build the command). */
export const HOOK_ENTRY = "src/claude-loop/hooks/hook-entry.ts";

/**
 * The hooks a loop installs today.
 *
 * SessionStart is registered against every entry mode so the initial drain
 * runs on `--resume` / `--continue` too (SSE only delivers NEW pings; existing
 * ones don't replay). `compact` is included so a post-compaction session-start
 * is not missed — the handler already handles `source === "compact"`, only the
 * matcher was absent under the old hand-built settings.
 *
 * PreToolUse gates `AskUserQuestion`: in an autonomous loop (no human) a
 * multi-choice dialog stalls, so the handler denies it and redirects to an
 * aiball ticket comment. Fail-open — see `hook-verdict.ts`.
 */
export const HOOKS: HookSpec[] = [
    {
        event: "SessionStart",
        matchers: ["startup", "resume", "clear", "compact"],
        module: "../session-start-hook.js",
    },
    { event: "Stop", module: "../stop-hook.js" },
    { event: "UserPromptSubmit", module: "../user-prompt-submit-hook.js" },
    { event: "PreToolUse", matchers: ["AskUserQuestion"], module: "../pretooluse-hook.js" },
    // #1315 S0 — a SPIKE, deliberately matcher-less. It changes no behaviour;
    // it records which notification types actually reach a loop and when, which
    // is the fact the rest of that ticket is waiting on. Registering it against
    // the types the docs list would answer the question with its own premise.
    { event: "Notification", module: "../notification-hook.js" },
];

/** One `{matcher?, hooks}` entry in a Claude Code `settings.hooks[event]` array. */
export interface HookEntry {
    matcher?: string;
    hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Build the `settings.hooks` object from a spec list. `buildCommand` turns the
 * dispatcher's repo-relative path into the concrete shell command (platform
 * quoting + tsx binary path live in the caller, so this stays pure/testable);
 * the event name is appended as the dispatcher's argument.
 *
 * Key order follows `specs` order, and `matcher` precedes `hooks` in each entry,
 * so the serialized JSON keeps a stable, diffable shape.
 */
export function buildHookSettings(
    specs: HookSpec[],
    buildCommand: (scriptRelPath: string) => string,
): Record<string, HookEntry[]> {
    const base = buildCommand(HOOK_ENTRY);
    const out: Record<string, HookEntry[]> = {};
    for (const spec of specs) {
        const command = `${base} ${spec.event}`;
        const entry = (matcher?: string): HookEntry => ({
            ...(matcher ? { matcher } : {}),
            hooks: [{ type: "command", command }],
        });
        out[spec.event] =
            spec.matchers && spec.matchers.length ? spec.matchers.map((m) => entry(m)) : [entry()];
    }
    return out;
}
