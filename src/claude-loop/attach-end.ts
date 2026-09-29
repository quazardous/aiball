/**
 * #3343 — when a terminal's `tmux attach` returns, say where the loop went:
 * still running in tmux (detached), moved to aiball's session host (a restart
 * there removes the tmux session and writes a new plate), or stopped. Without
 * it the terminal came back to the shell with tmux's bare `[exited]`.
 */
export interface LoopWhereabouts {
    /** Its tmux session is there. */
    tmuxAlive(): boolean;
    /** It runs on the session host now (its new plate names a host agent that runs). */
    onHost(): boolean;
}

export function attachEndMessage(name: string, w: LoopWhereabouts): string | null {
    if (w.tmuxAlive()) return `detached from '${name}' — the loop carries on in tmux (claude-loop attach ${name})`;
    if (w.onHost()) return `the loop '${name}' moved to aiball's session host — claude-loop attach ${name}, or open it in tvty`;
    return null;
}

/** The message, once the loop has settled: a restart takes a few seconds to write its new plate. */
export async function afterTmuxAttach(name: string, w: LoopWhereabouts, waitMs = 8000, stepMs = 250): Promise<string> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const m = attachEndMessage(name, w);
        if (m) return m;
        if (Date.now() >= deadline) return `the loop '${name}' stopped`;
        await new Promise((r) => setTimeout(r, stepMs));
    }
}
