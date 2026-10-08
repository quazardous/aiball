/**
 * #3686 — the subscription's usage (5-hour and weekly windows), which only
 * Claude Code knows and gives in one place: the JSON on its status line
 * command's stdin (`rate_limits`, claude.ai Pro/Max, after the first answer).
 * No hook or CLI gives it on demand, so the loop installs a status line of its
 * own (`status-line.ts`) that relays it and then runs the user's own status
 * line with the same stdin, so the screen does not change.
 *
 * Pure parts here: the reading as the bar carries it, and the status line
 * setting the loop spawns Claude with.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BarUsage, BarUsageWindow } from "../agent-bar.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One window, `resets_at` from epoch seconds to an ISO date; null when absent or malformed. */
function windowOf(w: unknown): BarUsageWindow | null {
    if (!isObj(w)) return null;
    const pct = w.used_percentage;
    const resets = w.resets_at;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) return null;
    if (typeof resets !== "number" || !Number.isFinite(resets) || resets <= 0) return null;
    return { used_percentage: pct, resets_at: new Date(resets * 1000).toISOString() };
}

/** The usage the bar carries from a status line's `rate_limits`; null when Claude Code gave none. */
export function usageOf(rateLimits: unknown, readAtMs: number): BarUsage | null {
    if (!isObj(rateLimits)) return null;
    return {
        five_hour: windowOf(rateLimits.five_hour),
        seven_day: windowOf(rateLimits.seven_day),
        read_at: new Date(readAtMs).toISOString(),
    };
}

/** The same reading, `read_at` aside: a new reading of the same numbers is not news. */
export function sameUsage(a: BarUsage | null, b: BarUsage | null): boolean {
    if (a === null || b === null) return a === b;
    return JSON.stringify([a.five_hour, a.seven_day]) === JSON.stringify([b.five_hour, b.seven_day]);
}

/** A status line setting, as Claude Code reads it. */
export interface StatusLineSetting {
    type: "command";
    command: string;
    [key: string]: unknown;
}

function statusLineIn(file: string): StatusLineSetting | null {
    try {
        const s = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).statusLine;
        return isObj(s) && s.type === "command" && typeof s.command === "string" && s.command.trim()
            ? s as StatusLineSetting
            : null;
    } catch { return null; }
}

/**
 * The user's own status line for a session in `cwd`: the first one set, in
 * Claude Code's order (the folder's local settings, its shared ones, then the
 * user's). The loop's own setting takes its place in the session, so the
 * loop's status line runs this one.
 */
export function userStatusLine(cwd: string, claudeDir: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): StatusLineSetting | null {
    for (const file of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(claudeDir, "settings.json")]) {
        const s = statusLineIn(file);
        if (s) return s;
    }
    return null;
}

/**
 * The status line the loop spawns Claude with: its own command, given the
 * user's as an argument (base64, so no quoting can break it), and the user's
 * other keys (`padding`, `refreshInterval`) kept as they were.
 */
export function loopStatusLine(command: string, user: StatusLineSetting | null): StatusLineSetting {
    return {
        ...(user ?? {}),
        type: "command",
        command: user ? `${command} ${Buffer.from(user.command, "utf8").toString("base64")}` : command,
    };
}
