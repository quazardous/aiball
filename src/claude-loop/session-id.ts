/**
 * #1549 — per-agent Claude Code session management.
 *
 * Problem: `claude --resume` (nu) opens the session picker and the loop
 * auto-crosses it with Enter = "pick latest" (kernel.ts crossResumePicker).
 * Fine for one loop per cwd, wrong the moment several persistent agents
 * (lead + crew) share a project: they all converge on the last session.
 *
 * Modes (`claude.session_mode`, lead only ; crew is forced to `managed`):
 *   - `auto`    — DEFAULT. First run: pass nothing, let claude create a session;
 *                 the SessionStart hook detects the real `session_id` and persists
 *                 it to `.aiball-session_id` (in the loop cwd). Next runs resume
 *                 that exact id (`--resume <id>`), PROVIDED its transcript is
 *                 still there — the persisted file outlives the session it names
 *                 (#1587), and resuming a pruned one kills the loop at boot.
 *                 Detection, not imposition.
 *   - `legacy`  — do nothing: the historical `always_resume` path (`--resume` nu
 *                 → pick latest). No session-id management at all.
 *   - `managed` — id DERIVED from the loop name (UUIDv5). Restart-proof (the loop
 *                 state-dir is wiped on restart, so we derive, not persist — same
 *                 name ⇒ same id). Created via `--session-id`, resumed via `--resume`.
 *   - `fixed`   — id supplied by the user (`claude.session_id`).
 *
 * For `managed`/`fixed`, `--session-id` (create) vs `--resume` (reprise) is
 * decided by whether the session's `<uuid>.jsonl` already exists under
 * ~/.claude/projects/<cwd>. For `auto` the persisted id is read from the
 * `.aiball-session_id` file (both fs probes are injected).
 *
 * This module is PURE (fs probes injected) so resolution is unit-testable
 * without spawning claude.
 */
import { createHash } from "node:crypto";

export type SessionMode = "legacy" | "auto" | "managed" | "fixed";

/** Name of the per-cwd file where `auto` mode persists the detected session id.
 *  Lives in the loop cwd (survives the state-dir wipe on restart); add it to
 *  `.gitignore` so it never gets committed. */
export const SESSION_ID_FILE = ".aiball-session_id";

/** Fixed aiball namespace UUID for the v5 derivation (any constant works —
 *  this one is arbitrary + stable so derived ids never change across versions). */
const AIBALL_SESSION_NS = "a1ba11-0000-4000-8000-000000000000".replace(/[^0-9a-f]/gi, "");

/**
 * Normalize a raw `session_mode` config value. Unknown / empty → `auto`
 * (the smart default: detect + persist + resume). Case-insensitive.
 */
export function normalizeSessionMode(raw: string | null | undefined): SessionMode {
    const v = (raw ?? "").trim().toLowerCase();
    return v === "legacy" || v === "managed" || v === "fixed" ? v : "auto";
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
    /** Does a session with this id already exist on disk (injected fs probe).
     *  Used by managed/fixed to pick create-vs-resume, and by `auto` to refuse
     *  resuming an id whose transcript is gone (#1587). */
    sessionExists: (id: string) => boolean;
    /** Read the persisted `.claude-session_id` for this cwd (injected; `auto`
     *  only). Return null when absent/unreadable. */
    readPersistedId: () => string | null;
}

export interface SessionResolvePlan {
    /** Effective mode actually applied (may downgrade to `auto` on misconfig). */
    mode: SessionMode;
    /** The resolved session id, or null (legacy always ; auto before first detect). */
    sessionId: string | null;
    /** Claude flags to prepend to claudeArgs. Empty for legacy + auto-first-run. */
    args: string[];
    /** Non-fatal warning to surface (e.g. `fixed` with a bad/empty id). */
    warning: string | null;
}

/**
 * Resolve the claude session flags for a loop.
 *  - `legacy` → empty plan; the caller runs its always_resume logic.
 *  - `auto`   → `--resume <id>` when a session id was persisted, else empty
 *               (fresh session; the SessionStart hook persists the detected id).
 *  - `managed`/`fixed` → `--session-id <id>` on first run, `--resume <id>` when
 *               the session already exists.
 */
export function resolveSession(input: SessionResolveInput): SessionResolvePlan {
    const { mode, configuredId, loopName, sessionExists, readPersistedId } = input;

    if (mode === "legacy") {
        return { mode: "legacy", sessionId: null, args: [], warning: null };
    }

    if (mode === "auto") {
        const persisted = readPersistedId();
        if (persisted && isValidUuid(persisted)) {
            const id = persisted.toLowerCase();
            // A well-formed id is not a live one. `.aiball-session_id` outlives
            // the transcript it names — the file sits in the project cwd while
            // claude prunes or rotates its own sessions — so `auto` could hand
            // claude `--resume <gone>`. claude then exits on the spot, the pane
            // dies, the mux session is reaped, and the kernel shuts down on
            // `watchdog:tmux-gone`: a loop that refuses to start with no error
            // anyone can see (#1587). managed/fixed already gate on this probe;
            // auto was the one path that trusted the file.
            if (sessionExists(id)) {
                return { mode: "auto", sessionId: id, args: ["--resume", id], warning: null };
            }
            return {
                mode: "auto",
                sessionId: null,
                args: [],
                warning: `persisted session ${id} no longer exists — starting a fresh one `
                    + `(stale ${SESSION_ID_FILE}; the SessionStart hook will re-persist)`,
            };
        }
        // First run (or file gone): pass nothing; the SessionStart hook detects
        // the id claude creates and persists it for next time.
        return { mode: "auto", sessionId: null, args: [], warning: null };
    }

    let id: string;
    if (mode === "fixed") {
        const trimmed = configuredId.trim();
        if (!isValidUuid(trimmed)) {
            // Misconfigured fixed mode → fall back to auto (detect+persist)
            // rather than feed claude a bad id (which would abort the boot).
            const persisted = readPersistedId();
            const resumeArgs = persisted && isValidUuid(persisted)
                ? ["--resume", persisted.toLowerCase()]
                : [];
            return {
                mode: "auto",
                sessionId: persisted && isValidUuid(persisted) ? persisted.toLowerCase() : null,
                args: resumeArgs,
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
        warning: null,
    };
}
