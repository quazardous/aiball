/**
 * Hook registry — the single declarative source of the Claude Code hooks a
 * loop installs. Adding or retuning a hook is one entry here, instead of
 * hand-editing the `settings.hooks` JSON in `cli.ts` (the old shape let a
 * matcher be silently forgotten — see the SessionStart `compact` note below).
 *
 * S1 scope: this drives ONLY the `settings.hooks` generation. Each event still
 * points at its own handler script; collapsing those into one generic entry is
 * a later slice.
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
    /** Handler script path, relative to the repo root. */
    script: string;
}

/**
 * The hooks a loop installs today.
 *
 * SessionStart is registered against every entry mode so the initial drain
 * runs on `--resume` / `--continue` too (SSE only delivers NEW pings; existing
 * ones don't replay). `compact` is included so a post-compaction session-start
 * is not missed — the emitter already handles `source === "compact"`, only the
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
        script: "src/claude-loop/session-start-hook.ts",
    },
    { event: "Stop", script: "src/claude-loop/stop-hook.ts" },
    { event: "UserPromptSubmit", script: "src/claude-loop/user-prompt-submit-hook.ts" },
    {
        event: "PreToolUse",
        matchers: ["AskUserQuestion"],
        script: "src/claude-loop/pretooluse-hook.ts",
    },
];

/** One `{matcher?, hooks}` entry in a Claude Code `settings.hooks[event]` array. */
export interface HookEntry {
    matcher?: string;
    hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Build the `settings.hooks` object from a spec list. `buildCommand` turns a
 * script's repo-relative path into the concrete shell command (platform quoting
 * + tsx binary path live in the caller, so this stays pure and testable).
 *
 * Key order follows `specs` order, and `matcher` precedes `hooks` in each entry,
 * so the serialized JSON matches the previous hand-built object (modulo the
 * added SessionStart `compact` matcher).
 */
export function buildHookSettings(
    specs: HookSpec[],
    buildCommand: (scriptRelPath: string) => string,
): Record<string, HookEntry[]> {
    const out: Record<string, HookEntry[]> = {};
    for (const spec of specs) {
        const command = buildCommand(spec.script);
        const entry = (matcher?: string): HookEntry => ({
            ...(matcher ? { matcher } : {}),
            hooks: [{ type: "command", command }],
        });
        out[spec.event] =
            spec.matchers && spec.matchers.length ? spec.matchers.map((m) => entry(m)) : [entry()];
    }
    return out;
}
