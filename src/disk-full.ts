/**
 * #3774 — a full disk is not a reason to die. On 2026-10-11 the disk filled:
 * the daemon died on a SQLITE_FULL thrown from a timer, and every loop kernel
 * died with it, leaving their Claude running with nothing to drive it. A write
 * that fails for want of space loses that write; the process carries on and
 * works again once space is back.
 *
 * Only that: any other uncaught error ends the process as Node would.
 */

/** A write refused for want of space: the disk, a quota, or SQLite's own. */
export function isDiskFull(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    return code === "ENOSPC" || code === "EDQUOT" || code === "SQLITE_FULL";
}

const WARN_EVERY_MS = 60_000;

/**
 * Keep this process alive through disk-full errors: uncaught ones, and a
 * stdout or stderr that cannot be written (a kernel's log is its stdout, a
 * file). One warning a minute at most, on stderr: the log may be the file
 * that cannot grow.
 */
export function surviveDiskFull(tag: string): void {
    let lastWarn = 0;
    let skipped = 0;
    const warn = (e: unknown): void => {
        const now = Date.now();
        if (now - lastWarn < WARN_EVERY_MS) { skipped++; return; }
        lastWarn = now;
        const more = skipped > 0 ? ` (${skipped} more since the last warning)` : "";
        skipped = 0;
        try { process.stderr.write(`[${tag}] disk full, a write was lost: ${(e as Error).message ?? String(e)}${more}\n`); } catch { /* stderr full too */ }
    };
    process.on("uncaughtException", (e) => {
        if (isDiskFull(e)) { warn(e); return; }
        // As Node does without a handler: the error, then out.
        try { process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`); } catch { /* nothing left to tell */ }
        process.exit(1);
    });
    for (const stream of [process.stdout, process.stderr]) {
        stream.on("error", (e) => { if (!isDiskFull(e)) throw e; });
    }
}
