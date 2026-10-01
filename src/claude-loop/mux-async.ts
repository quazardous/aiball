/**
 * #3461 — tmux / psmux called without holding the process. A `spawnSync` of
 * the multiplexer froze the loop kernel and the daemon for the whole call:
 * on Windows a psmux call costs about 100 ms, and the kernel read the screen
 * (two calls) every 200 ms while Claude worked, so keys, F9 and its own
 * timers waited in line, and the daemon stalled every 30 s listing its loops.
 */
import { spawn } from "node:child_process";
import { resolveMuxCmd } from "./mux-cmd.js";
import { parseClientCounts } from "./mux-clients.js";

/** The multiplexer, resolved as state.ts does (not imported from it: state.ts uses this module). */
const MUX_CMD = resolveMuxCmd(process.env.MUX_CMD);

export interface MuxResult {
    /** Exit status; null when the command did not run. */
    status: number | null;
    stdout: string;
    /** Set when the command could not be started (not found, …). */
    error?: Error;
}

/** Run the multiplexer with `args`; resolves once it exits. Never rejects. */
export function muxRun(args: string[], cmd: string = MUX_CMD): Promise<MuxResult> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        } catch (e) {
            resolve({ status: null, stdout: "", error: e as Error });
            return;
        }
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (b: Buffer) => chunks.push(b));
        let error: Error | undefined;
        child.on("error", (e) => { error = e; });
        child.on("close", (code) => resolve({ status: error ? null : code, stdout: Buffer.concat(chunks).toString("utf8"), ...(error ? { error } : {}) }));
    });
}

/**
 * Calls that must land in the order they were asked (the bar's options: a
 * later value must not be overwritten by an earlier one finishing last), run
 * one after the other, without the caller waiting.
 */
export function muxQueue(run: (args: string[]) => Promise<unknown> = muxRun): { push(args: string[]): void; idle(): Promise<void> } {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        push(args) {
            tail = tail.then(() => run(args)).catch(() => { /* one failed write does not stop the next */ });
        },
        idle: () => tail.then(() => undefined),
    };
}

/**
 * #3340 — the clients attached to a tmux session: how many, and how many have
 * the controls (not `client_readonly`). Null when tmux cannot say. The
 * session's name is the loop's (`tmuxName` is the identity).
 */
export async function tmuxClientsAsync(session: string, run: (args: string[]) => Promise<MuxResult> = muxRun): Promise<{ clients: number; interactive: number | null } | null> {
    const r = await run(["list-clients", "-t", session, "-F", "#{client_readonly}"]);
    if (r.error || r.status !== 0) return null;
    // #3477 — `interactive` null under psmux, which cannot say who is read-only.
    return parseClientCounts(r.stdout);
}

/** The tmux sessions that exist now, in one call; null when tmux cannot say (no server is not that: none). */
export async function tmuxSessions(run: (args: string[]) => Promise<MuxResult> = muxRun): Promise<Set<string> | null> {
    const r = await run(["ls", "-F", "#{session_name}"]);
    if (r.error) return null;
    // No server running answers non-zero: no session at all.
    if (r.status !== 0) return new Set();
    return new Set(r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
}
