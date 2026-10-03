/**
 * #3509 — `claude_loop.on_repetitive_denied`: when Claude Code's permission
 * system keeps denying a loop's Claude (the auto mode classifier has false
 * positives — a `mkdir` refused), the loop can answer with a prompt the user
 * configured: a static text sent as it is, or what an external command makes
 * of the context. aiball ships the mechanism; the words are the user's. Empty
 * by default: nothing is ever sent unless configured.
 *
 * The prompt is sent like a wake, through the same gate (no AFK hold, zen,
 * typing, limit, boot or busy), and at most `max_per_hour` times an hour, so a
 * denial → prompt → denial cycle stops. Every send is logged and counted in
 * the bar (`denials.sent`).
 */
import { spawn } from "node:child_process";
import { denialsInLastHour, type Denial, type DenialLog } from "./denials.js";

export interface OnRepetitiveDenied {
    /** Denials in the last hour before the loop answers. */
    threshold: number;
    /** Sent as it is; empty = none. */
    prompt: string;
    /** An external command: its stdout is the prompt; null = none. Wins over `prompt`. */
    command: string | null;
    /** At most this many prompts an hour. */
    max_per_hour: number;
}

export const ON_REPETITIVE_DENIED_DEFAULT: OnRepetitiveDenied = { threshold: 3, prompt: "", command: null, max_per_hour: 2 };

/** The config block as written; anything malformed falls back to its default. */
export function parseOnRepetitiveDenied(raw: unknown): OnRepetitiveDenied {
    const d = ON_REPETITIVE_DENIED_DEFAULT;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...d };
    const r = raw as Record<string, unknown>;
    const count = (v: unknown, def: number, min: number) => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : def);
    return {
        threshold: count(r.threshold, d.threshold, 1),
        prompt: typeof r.prompt === "string" ? r.prompt : d.prompt,
        command: typeof r.command === "string" && r.command.trim() ? r.command.trim() : null,
        max_per_hour: count(r.max_per_hour, d.max_per_hour, 0),
    };
}

/** Whether a configured prompt exists at all. */
export function deniedPromptConfigured(cfg: OnRepetitiveDenied): boolean {
    return cfg.command !== null || cfg.prompt.trim() !== "";
}

/**
 * Whether this denial calls for a prompt: one is configured, the last hour
 * holds `threshold` denials or more, and fewer than `max_per_hour` prompts were
 * sent in it. Null when yes; otherwise why not, for the log.
 */
export function deniedPromptBlocker(cfg: OnRepetitiveDenied, log: DenialLog, nowMs: number): string | null {
    if (!deniedPromptConfigured(cfg)) return "no prompt configured";
    const { denied, sent } = denialsInLastHour(log, nowMs);
    if (denied.length < cfg.threshold) return `${denied.length}/${cfg.threshold} denials in the last hour`;
    if (sent >= cfg.max_per_hour) return `${sent}/${cfg.max_per_hour} prompts already sent in the last hour`;
    return null;
}

/** What an external command gets on stdin. */
export interface DeniedContext {
    agent: string | null;
    project: string | null;
    cwd: string;
    tool: string | null;
    reason: string | null;
    last_hour: number;
    recent: Array<{ at: string; tool: string | null; reason: string | null }>;
}

export function deniedContext(o: { agent: string | null; project: string | null; cwd: string }, recent: Denial[]): DeniedContext {
    const last = recent[recent.length - 1];
    return {
        ...o,
        tool: last?.tool ?? null,
        reason: last?.reason ?? null,
        last_hour: recent.length,
        recent: recent.map((d) => ({ at: new Date(d.atMs).toISOString(), tool: d.tool, reason: d.reason })),
    };
}

export const COMMAND_TIMEOUT_MS = 10_000;
const MAX_PROMPT = 2000;

export type DeniedPrompt = { text: string; source: "prompt" | "command" } | { none: string };

/**
 * The prompt to send: the command's stdout (trimmed, cut) when a command is
 * set, else the static text. A command that fails, times out or prints
 * nothing sends nothing, and says why.
 */
export async function resolveDeniedPrompt(cfg: OnRepetitiveDenied, ctx: DeniedContext, shell = "/bin/sh", timeoutMs = COMMAND_TIMEOUT_MS): Promise<DeniedPrompt> {
    const cut = (s: string) => (s.length > MAX_PROMPT ? s.slice(0, MAX_PROMPT) : s);
    if (cfg.command === null) {
        const text = cfg.prompt.trim();
        return text ? { text: cut(text), source: "prompt" } : { none: "empty prompt" };
    }
    return new Promise<DeniedPrompt>((resolve) => {
        let out = "";
        let done = false;
        const finish = (r: DeniedPrompt) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
        const child = spawn(shell, ["-c", cfg.command!], { cwd: ctx.cwd, stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ none: `command timed out after ${timeoutMs} ms` }); }, timeoutMs);
        child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); if (out.length > MAX_PROMPT * 4) child.kill("SIGKILL"); });
        child.on("error", (e) => finish({ none: `command failed: ${e.message}` }));
        child.on("close", (code) => {
            if (code !== 0) return finish({ none: `command exited ${code}` });
            const text = out.trim();
            finish(text ? { text: cut(text), source: "command" } : { none: "command printed nothing" });
        });
        child.stdin.on("error", () => { /* a command that does not read its input */ });
        child.stdin.end(JSON.stringify(ctx));
    });
}
