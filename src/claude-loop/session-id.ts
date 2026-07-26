/**
 * #1549 — per-agent Claude Code session management.
 *
 * Problem: `claude --resume` (nu) opens the session picker and the loop
 * auto-crosses it with Enter = "pick latest" (kernel.ts crossResumePicker).
 * Fine for one loop per cwd, wrong the moment several persistent agents
 * (lead + crew) share a project: they all converge on the last session.
 *
 * Fix: assign each agent a deterministic session id and resume THAT exact
 * session (`--resume <uuid>`), or create it on first run (`--session-id <uuid>`).
 * No detection, no picker — the agent→session mapping holds by construction.
 *
 * Modes (`claude.session_mode`, lead only ; crew is forced to `managed`):
 *   - `auto`    — statu quo (handled by the caller's always_resume block, NOT here).
 *   - `managed` — id DERIVED from the loop name (UUIDv5). Restart-proof: the
 *                 loop state-dir is wiped on restart, so we derive rather than
 *                 persist — same name ⇒ same id, forever.
 *   - `fixed`   — id supplied by the user (`claude.session_id`).
 *
 * `--session-id` (create) vs `--resume` (reprise) is decided by whether the
 * session's `<uuid>.jsonl` already exists under ~/.claude/projects/<cwd>.
 *
 * This module is PURE (the filesystem probe is injected) so the whole
 * resolution is unit-testable without spawning claude.
 */
import { createHash } from "node:crypto";

export type SessionMode = "auto" | "managed" | "fixed";

/** Fixed aiball namespace UUID for the v5 derivation (any constant works —
 *  this one is arbitrary + stable so derived ids never change across versions). */
const AIBALL_SESSION_NS = "a1ba11-0000-4000-8000-000000000000".replace(/[^0-9a-f]/gi, "");

/**
 * Normalize a raw `session_mode` config value. Unknown / empty → `auto`
 * (the safe statu-quo default). Case-insensitive.
 */
export function normalizeSessionMode(raw: string | null | undefined): SessionMode {
    const v = (raw ?? "").trim().toLowerCase();
    return v === "managed" || v === "fixed" ? v : "auto";
}

/** True for a syntactically valid UUID (8-4-4-4-12 hex). */
export function isValidUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * Deterministic RFC-4122 v5-style UUID from a stable key (the loop name).
 * Same key ⇒ same UUID, so a `managed` agent always maps to the same
 * session with no persistence to lose across restarts / state-dir wipes.
 */
export function deterministicSessionId(key: string): string {
    const h = createHash("sha1")
        .update(Buffer.from(AIBALL_SESSION_NS.padEnd(32, "0").slice(0, 32), "hex"))
        .update(key)
        .digest();
    h[6] = (h[6] & 0x0f) | 0x50; // version 5
    h[8] = (h[8] & 0x3f) | 0x80; // RFC-4122 variant
    const hex = h.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SessionResolveInput {
    /** Effective mode — the caller forces `managed` for crew before calling. */
    mode: SessionMode;
    /** `claude.session_id` from config (only used in `fixed` mode). */
    configuredId: string;
    /** Loop name — the stable identity the managed id is derived from. */
    loopName: string;
    /** Does a session with this id already exist on disk (injected fs probe). */
    sessionExists: (id: string) => boolean;
}

export interface SessionResolvePlan {
    /** Effective mode actually applied (may downgrade to `auto` on misconfig). */
    mode: SessionMode;
    /** The resolved session id, or null in `auto` (caller keeps its own path). */
    sessionId: string | null;
    /** Claude flags to prepend to claudeArgs. Empty in `auto`. */
    args: string[];
    /** Non-fatal warning to surface (e.g. `fixed` with a bad/empty id). */
    warning: string | null;
}

/**
 * Resolve the claude session flags for a loop. `auto` returns an empty plan
 * (the caller runs its legacy always_resume logic); `managed`/`fixed` return
 * `--session-id <id>` on first run or `--resume <id>` when the session exists.
 */
export function resolveSession(input: SessionResolveInput): SessionResolvePlan {
    const { mode, configuredId, loopName, sessionExists } = input;

    if (mode === "auto") {
        return { mode: "auto", sessionId: null, args: [], warning: null };
    }

    let id: string;
    let warning: string | null = null;
    if (mode === "fixed") {
        const trimmed = configuredId.trim();
        if (!isValidUuid(trimmed)) {
            // Misconfigured fixed mode → fall back to auto rather than feed
            // claude a bad id (which would abort the boot).
            return {
                mode: "auto",
                sessionId: null,
                args: [],
                warning: `claude.session_mode=fixed but claude.session_id is missing/invalid ("${configuredId}") — falling back to auto`,
            };
        }
        id = trimmed.toLowerCase();
    } else {
        // managed
        id = deterministicSessionId(loopName);
    }

    const resume = sessionExists(id);
    return {
        mode,
        sessionId: id,
        args: resume ? ["--resume", id] : ["--session-id", id],
        warning,
    };
}
