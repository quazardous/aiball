/**
 * #404 — token-effort capture (claude-loop side, best-effort).
 *
 * After each turn the Stop-hook calls `captureTokenUsage` (in a try/catch, so it
 * NEVER affects the wake). It:
 *   1. discovers the active session transcript (cwd → encoded project dir →
 *      latest `.jsonl` by mtime — the session being written IS the newest);
 *   2. reads the LATEST assistant turn's `usage`, deduped by message id (a
 *      state file holds the last-pushed id, so a re-fired hook doesn't
 *      double-count);
 *   3. reads the `active-ticket` marker (written by the aiball MCP server on
 *      each ticket-scoped tool call) and pushes the turn's usage to that ticket.
 *      (#439: the daemon then RE-ANCHORS that push onto the caller's held live
 *      claim if any — the marker is just the fallback. Loop side stays dumb.)
 *
 * Pure FS + an injected `postUsage`, so the discovery / latest-turn / dedup
 * logic unit-tests without a daemon (same shape as start-lock.ts).
 */
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code encodes the project dir by replacing path-punctuation chars
 * with '-' :
 *   - `/` et `.` sur POSIX (cas historique pré-Windows).
 *   - `\` et `:` aussi sur Windows (#517 david `vb9umt`) — sinon
 *     `C:\Users\david\dev\aiball` reste tel quel et ne matche pas la dir
 *     Claude Code (`C-Users-david-dev-aiball`), `latestSessionFile` →
 *     null, et le token-push n'est jamais déclenché pour les agents
 *     graphite/Windows. Résolution : regex inclut les 4 séparateurs.
 */
export function projectTranscriptDir(cwd: string): string {
    return join(homedir(), ".claude", "projects", cwd.replace(/[/.\\:]/g, "-"));
}

/** Newest `.jsonl` in `dir` (the active session is the most recently written). */
export function latestSessionFile(dir: string): string | null {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    return files[0] ? join(dir, files[0].f) : null;
}

export interface TurnUsage {
    /** API message id — the dedup key (one push per turn). */
    id: string;
    in: number;
    out: number;
    cacheW: number;
    cacheR: number;
}

/** The LAST assistant message carrying `usage` in the transcript = the turn that
 *  just ended. Returns null if none / unreadable. */
export function latestTurnUsage(file: string): TurnUsage | null {
    let last: TurnUsage | null = null;
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return null; }
    for (const line of content.split("\n")) {
        if (!line) continue;
        let o: { message?: { role?: string; id?: string; usage?: Record<string, number> }; uuid?: string };
        try { o = JSON.parse(line); } catch { continue; }
        const m = o.message;
        if (!m || m.role !== "assistant" || !m.usage) continue;
        const id = m.id ?? o.uuid ?? "";
        if (!id) continue;
        const u = m.usage;
        last = {
            id: String(id),
            in: u.input_tokens ?? 0,
            out: u.output_tokens ?? 0,
            cacheW: u.cache_creation_input_tokens ?? 0,
            cacheR: u.cache_read_input_tokens ?? 0,
        };
    }
    return last;
}

/** Marker the MCP server writes (the ticket the agent is focused on). */
export function activeTicketMarkerPath(stateDir: string): string {
    return join(stateDir, "active-ticket");
}

/**
 * Outcome of a capture attempt — returned so the caller can log it (the
 * capture is best-effort + silent otherwise, which made #404 hard to debug:
 * david `wezr82` "y a eu un enregistrement mais là ça bouge plus").
 */
export type CaptureResult =
    | { status: "no-file" }                                   // transcript dir empty / wrong
    | { status: "no-turn" }                                   // no assistant turn with usage
    | { status: "deduped"; id: string }                       // this turn already pushed
    | { status: "no-marker"; id: string }                     // no active-ticket focus
    | { status: "push-failed"; ticketId: number; id: string } // marker ok, POST threw
    | { status: "pushed"; ticketId: number; turn: TurnUsage }; // success

/**
 * Read each turn's usage once and push it to the active ticket. Best-effort:
 * any FS/read miss is a no-op. `postUsage` is injected (the hook passes a
 * client call); it is NOT invoked when there is no active-ticket marker.
 * Returns a `CaptureResult` describing what happened (for the hook's log).
 */
export async function captureTokenUsage(opts: {
    transcriptDir: string;
    stateDir: string;
    postUsage: (ticketId: number, u: TurnUsage) => Promise<unknown> | void;
    /**
     * #446 (david 9qtewx): when set, attribute this turn to THIS ticket instead
     * of reading the `active-ticket` marker — so the MCP server can drain the
     * effort "au plus tôt" on each project-attachable tool call (to the call's
     * own ticket), not only at the Stop-hook. The Stop-hook keeps calling
     * WITHOUT this (→ reads the marker = the last-focused ticket, drains the
     * turn's tail). Both share the `token-push-last-id` dedup below, so a turn
     * is counted ONCE whichever drains it first.
     */
    targetTicketId?: number;
}): Promise<CaptureResult> {
    const file = latestSessionFile(opts.transcriptDir);
    if (!file) return { status: "no-file" };
    const turn = latestTurnUsage(file);
    if (!turn) return { status: "no-turn" };

    const lastIdPath = join(opts.stateDir, "token-push-last-id");
    let lastId = "";
    try { lastId = readFileSync(lastIdPath, "utf8").trim(); } catch { /* none yet */ }
    if (turn.id === lastId) return { status: "deduped", id: turn.id }; // already pushed

    let ticketId = NaN;
    if (opts.targetTicketId != null && opts.targetTicketId > 0) {
        ticketId = opts.targetTicketId; // #446: explicit per-call target
    } else {
        const markerPath = activeTicketMarkerPath(opts.stateDir);
        try { ticketId = Number(readFileSync(markerPath, "utf8").trim()); } catch { /* no focus */ }
    }
    const hasMarker = Number.isFinite(ticketId) && ticketId > 0;

    // CLAIM the dedup synchronously BEFORE the (async) push: two concurrent
    // drains of the same turn — e.g. parallel tool calls, or an MCP-call drain
    // racing the Stop-hook — see the id already recorded and short-circuit, so
    // a turn is never double-counted. Recorded even with no marker / on a failed
    // push so we don't re-scan it (statistical by design).
    try { writeFileSync(lastIdPath, turn.id); } catch { /* best-effort */ }

    let pushed = false;
    if (hasMarker) {
        // Awaited so the hook doesn't exit before the request flushes; wrapped
        // so a failed push never throws into the wake path (best-effort).
        try { await opts.postUsage(ticketId, turn); pushed = true; } catch { /* best-effort */ }
    }

    if (!hasMarker) return { status: "no-marker", id: turn.id };
    return pushed
        ? { status: "pushed", ticketId, turn }
        : { status: "push-failed", ticketId, id: turn.id };
}
