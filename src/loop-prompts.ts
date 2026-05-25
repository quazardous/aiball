/**
 * #451 — VOLATILE in-memory spool for operator → loop raw prompts (david: "spoolé
 * volatile dans aiball, pas de table ou autre pour le moment"). A prompt is
 * queued in the daemon's memory, then delivered: if the loop is live it's drained
 * onto its SSE now; if it's offline it waits in memory and is drained when the
 * loop's SSE (re)connects. Volatile by design — a daemon restart clears the queue
 * (acceptable for now; no DB table, no file).
 *
 * The queue is a process-global Map, shared by the POST endpoint and the SSE
 * handler (same daemon process). Draining removes the entries — drained == sent.
 */
const spool = new Map<string, string[]>();

/** Queue a prompt for a consumer (FIFO — oldest delivered first). */
export function spoolPrompt(consumer: string, text: string): void {
    const q = spool.get(consumer);
    if (q) q.push(text);
    else spool.set(consumer, [text]);
}

/** Take (and remove) every queued prompt for a consumer, oldest first. */
export function drainPrompts(consumer: string): string[] {
    const q = spool.get(consumer);
    if (!q) return [];
    spool.delete(consumer);
    return q;
}

/** How many prompts are queued (undelivered) for a consumer — for the UI. */
export function countSpooledPrompts(consumer: string): number {
    return spool.get(consumer)?.length ?? 0;
}
