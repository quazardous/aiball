// #1032 — per-component OFFLOAD buffer for when the IPC channel to the timer
// is down (e.g. the timer self-reloaded on a code change and the proxy hasn't
// reconnected yet). Instead of losing the event/log in a swallowed catch, the
// component appends it here, in a file named per component, WITH its original
// timestamp. On reconnect (S2), `drainOffload` replays the buffered entries
// into the central log (`createLogger`) preserving `ts` → one unified timeline,
// then clears the buffer.
//
// Invariant : this is the FALLBACK path. It must NEVER throw (a failure here
// would cascade exactly when things are already broken) and it is a SEPARATE
// channel from the central NDJSON log (which stays owned by `createLogger`).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One buffered entry. Mirrors the central `LogRecord` shape (`ts` ISO) plus a
 *  `component` discriminator and a free-form payload, so a drained entry maps
 *  cleanly onto a central log line with its ORIGINAL `ts` preserved. */
export interface OffloadEntry {
    /** ISO timestamp — the ORIGINAL time of the event (preserved through the
     *  eventual drain, NOT the drain time). */
    ts: string;
    component: string;
    /** Event/log kind (e.g. the IPC event kind that couldn't be delivered). */
    kind: string;
    /** Optional human message. */
    msg?: string;
    [k: string]: unknown;
}

export function offloadDir(sd: string): string {
    return join(sd, "offload");
}

export function offloadPath(sd: string, component: string): string {
    return join(offloadDir(sd), `${component}.ndjson`);
}

/**
 * Append one entry to the component's offload buffer. Best-effort : never
 * throws. The caller may pass an explicit `ts` (preserved); otherwise it is
 * stamped now.
 */
export function appendOffload(
    sd: string,
    component: string,
    entry: { kind: string; msg?: string; ts?: string } & Record<string, unknown>,
): void {
    try {
        mkdirSync(offloadDir(sd), { recursive: true });
        const rec: OffloadEntry = {
            ...entry,
            ts: entry.ts ?? new Date().toISOString(),
            component,
            kind: entry.kind,
        };
        appendFileSync(offloadPath(sd, component), JSON.stringify(rec) + "\n");
    } catch { /* fallback path — swallow, must not cascade */ }
}

/**
 * Read + parse every buffered entry (insertion order), then CLEAR the buffer.
 * For the reconnect drain (S2) : the caller replays each entry into the central
 * log preserving `ts`. Returns `[]` when the buffer is absent/empty/unreadable.
 * Best-effort clear. (Small race : an append between read and clear is rare and
 * tolerable for a diagnostic buffer.)
 */
export function drainOffload(sd: string, component: string): OffloadEntry[] {
    const path = offloadPath(sd, component);
    let raw: string;
    try { raw = readFileSync(path, "utf8"); }
    catch { return []; }
    const out: OffloadEntry[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as OffloadEntry); }
        catch { /* skip malformed line */ }
    }
    try { writeFileSync(path, ""); }
    catch { /* swallow */ }
    return out;
}
