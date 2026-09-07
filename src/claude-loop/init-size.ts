/**
 * The geometry claude should boot with.
 *
 * `claude-loop start` creates the mux session DETACHED, so when the PTY proxy
 * opens claude's inner PTY there is no client attached and the pane reports the
 * multiplexer's default width (120 on psmux). claude paints itself at that
 * width, the user attaches, the pane jumps to the real terminal size, and the
 * proxy's resize poll propagates it a tick later. That tick is the visible
 * reflow a fraction of a second after launch (david `<chat>` 2026-09-07).
 *
 * Measuring harder inside the proxy cannot help: at that instant the small size
 * is not a misreading, it is the truth. But `claude-loop start` itself runs in
 * the user's real terminal, so IT can see the size claude will actually end up
 * with, and hand it down (`CL_INIT_SIZE`) for the proxy to open the PTY with.
 *
 * Deliberately not persisted anywhere. An earlier sketch remembered the last
 * known size in a file, which needed a home outside the per-loop state-dir
 * (`start` wipes that on restart — cli.ts), an invalidation story, and a
 * staleness policy. A live measurement has none of those and is more accurate:
 * it describes the terminal in front of the user right now, not the one that
 * was there last time.
 */

/** The `<rows>,<cols>` wire format `cl-pty-proxy` parses (`core.rs::parse_size`). */
export function formatInitSize(rows: number, cols: number): string {
    return `${rows},${cols}`;
}

/**
 * The value for `CL_INIT_SIZE`, or `null` when this process has no terminal to
 * measure — started from a pipe, a service, a cron, a test. `null` is a normal
 * outcome, not a failure: the proxy then probes as it always did, and the user
 * gets exactly today's behaviour rather than a wrong hint.
 *
 * Absurd values are rejected for the same reason the Rust side rejects them —
 * a bogus geometry handed to `openpty` breaks the pane, which is far worse than
 * the reflow this whole thing exists to avoid. The bounds mirror
 * `core.rs::parse_size` so neither side accepts what the other would refuse.
 */
export function resolveInitSize(
    cols: number | undefined,
    rows: number | undefined,
): string | null {
    const size = terminalSize(cols, rows);
    return size ? formatInitSize(size.rows, size.cols) : null;
}

/** The measured terminal, or `null` when there is no terminal to measure. */
export function terminalSize(
    cols: number | undefined,
    rows: number | undefined,
): { rows: number; cols: number } | null {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
    const c = cols as number;
    const r = rows as number;
    if (c <= 0 || r <= 0 || c > 2000 || r > 2000) return null;
    return { rows: r, cols: c };
}

/**
 * `-x`/`-y` for `new-session`, so the pane is born the size of the terminal.
 *
 * This is the fix; `CL_INIT_SIZE` was only ever half of one. Handing the size
 * to the proxy made claude OPEN correctly, but the session was still created
 * detached, so ~200 ms later the proxy's resize poll read the pane — still the
 * multiplexer's 120-column default, because nobody had attached yet — and
 * shrank claude back to it. Measured: claude was at 120 by the child's first
 * `tput cols`. The reflow was not removed, only moved.
 *
 * Sizing the SESSION removes the disagreement at its source rather than
 * defending against it: the pane, the proxy's probe, claude, and the resize
 * poll all see the same number from the first instant. Nothing has to win a
 * race, and no boot-grace heuristic has to guess how long an attach takes.
 *
 * Empty off a TTY — a piped or service start has no terminal to copy, and the
 * multiplexer's default is then exactly the right answer.
 */
export function newSessionSizeArgs(
    cols: number | undefined,
    rows: number | undefined,
): string[] {
    const size = terminalSize(cols, rows);
    return size ? ["-x", String(size.cols), "-y", String(size.rows)] : [];
}
