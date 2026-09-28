/**
 * #3254 — Claude's Remote Control (`claude --remote-control [name]`): an
 * agent's session picked up from claude.ai or the phone. A project setting
 * (`claude.remote_control`), a loop's own choice over it (the start flags,
 * kept in the plate and replayed on restart), and the flag they make.
 */

/** Off, on (the session named after the agent), or on under this name. */
export type RemoteControl = boolean | string;

/** A value read from a config or a flag; null when it says nothing usable. */
export function parseRemoteControl(v: unknown): RemoteControl | null {
    if (typeof v === "boolean") return v;
    if (typeof v === "string" && v.trim() && !v.trim().startsWith("-")) return v.trim();
    return null;
}

/** What Claude's own args (after `--`) already ask for, or null. */
function askedInArgs(args: string[]): RemoteControl | null {
    const i = args.findIndex((a) => a === "--remote-control" || a.startsWith("--remote-control="));
    if (i < 0) return null;
    const a = args[i];
    if (a.includes("=")) return a.slice(a.indexOf("=") + 1) || true;
    const next = args[i + 1];
    return next !== undefined && !next.startsWith("-") ? next : true;
}

/**
 * The loop's Remote Control and the args it adds: the loop's choice, else the
 * setting; `true` names the session after the agent. Claude's own args asking
 * for it are left alone, as `-n` is.
 */
export function remoteControlPlan(
    setting: RemoteControl,
    choice: RemoteControl | null | undefined,
    agent: string,
    claudeArgs: string[],
): { value: RemoteControl; args: string[] } {
    const asked = askedInArgs(claudeArgs);
    if (asked !== null) return { value: asked, args: [] };
    const v = choice ?? setting;
    if (v === false) return { value: false, args: [] };
    const name = v === true ? agent : v;
    return { value: name, args: ["--remote-control", name] };
}

/** The claude-loop flags that say a choice again (restart, the bus). */
export function remoteControlFlags(choice: RemoteControl | null | undefined): string[] {
    if (choice === undefined || choice === null) return [];
    if (choice === false) return ["--no-remote-control"];
    return choice === true ? ["--remote-control"] : ["--remote-control", choice];
}
