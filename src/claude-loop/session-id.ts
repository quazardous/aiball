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
 *                 (#1549), and resuming a pruned one kills the loop at boot.
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
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export type SessionMode = "legacy" | "auto" | "managed" | "fixed";

/** Name of the per-cwd file where `auto` mode persists the detected session id.
 *  Lives in the loop cwd (survives the state-dir wipe on restart); add it to
 *  `.gitignore` so it never gets committed. */
export const SESSION_ID_FILE = ".aiball-session_id";

/**
 * #2523 david — "il faut que le .aiball-session_id soit une structure avec la
 * session par défaut et les sessions pour chaque sous-agent". Several loops
 * share one project folder — the main one and its crew agents — and each
 * resumes its own session. The file used to hold one bare id, which a second
 * agent could only overwrite.
 *
 *     { "default": "<uuid>", "agents": { "<crew agent>": "<uuid>" } }
 *
 * `default` is the folder's main loop; `agents.<name>` a crew agent's.
 */
export interface SessionFile {
    default: string | null;
    agents: Record<string, string>;
}

/** The entry key of a loop: its agent for a crew, `default` otherwise. */
export function sessionKeyFor(role: string | null | undefined, agent: string | null | undefined): string {
    return role === "crew" && agent ? `agent:${agent}` : "default";
}

/**
 * Read the file's text. An old file holding one bare id is that id as
 * `default`. Anything unreadable comes back empty with `corrupt: true`, so the
 * loop starts a fresh session instead of dying at boot.
 */
export function parseSessionFile(text: string | null | undefined): { file: SessionFile; corrupt: boolean } {
    const empty = (): SessionFile => ({ default: null, agents: {} });
    const raw = (text ?? "").trim();
    if (!raw) return { file: empty(), corrupt: false };
    if (isValidUuid(raw)) return { file: { default: raw.toLowerCase(), agents: {} }, corrupt: false };
    try {
        const j = JSON.parse(raw) as { default?: unknown; agents?: unknown };
        if (!j || typeof j !== "object" || Array.isArray(j)) return { file: empty(), corrupt: true };
        const file = empty();
        if (typeof j.default === "string" && isValidUuid(j.default)) file.default = j.default.toLowerCase();
        if (j.agents && typeof j.agents === "object" && !Array.isArray(j.agents)) {
            for (const [name, id] of Object.entries(j.agents as Record<string, unknown>)) {
                if (typeof id === "string" && isValidUuid(id)) file.agents[name] = id.toLowerCase();
            }
        }
        return { file, corrupt: false };
    } catch {
        return { file: empty(), corrupt: true };
    }
}

export function serializeSessionFile(file: SessionFile): string {
    return JSON.stringify({ default: file.default, agents: file.agents }, null, 2) + "\n";
}

/** The id recorded for `key`, or null. */
export function sessionEntry(file: SessionFile, key: string): string | null {
    if (key === "default") return file.default;
    return file.agents[key.slice("agent:".length)] ?? null;
}

/**
 * Record `id` under `key` in the session file at `path`: take a short lock,
 * read, set that one entry, write a temp file, rename it over, release.
 *
 * The rename alone keeps a reader from seeing half a file, but not two loops of
 * the same folder from each reading the old file and the second write dropping
 * the first one's entry — the very overwrite the structure exists to prevent.
 * The lock serialises the read-modify-write. A lock older than a few seconds is
 * a crashed writer's and is taken over; past the wait, the write goes ahead
 * unlocked rather than lose the session id altogether.
 */
export function recordSessionEntry(path: string, key: string, id: string): void {
    const lock = `${path}.lock`;
    let held = false;
    const deadline = Date.now() + 2000;
    while (!held) {
        try {
            closeSync(openSync(lock, "wx"));
            held = true;
        } catch {
            try {
                if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
            } catch { /* released meanwhile */ }
            if (Date.now() > deadline) break;
            const until = Date.now() + 5;
            while (Date.now() < until) { /* short spin: a hook process, no event loop to yield to */ }
        }
    }
    try {
        let text: string | null = null;
        try { text = readFileSync(path, "utf8"); } catch { /* no file yet */ }
        const next = withSessionEntry(parseSessionFile(text).file, key, id);
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, serializeSessionFile(next));
        renameSync(tmp, path);
    } finally {
        if (held) try { unlinkSync(lock); } catch { /* already gone */ }
    }
}

/** A copy of `file` with `key` set to `id` — every other entry untouched. */
export function withSessionEntry(file: SessionFile, key: string, id: string): SessionFile {
    if (key === "default") return { default: id.toLowerCase(), agents: { ...file.agents } };
    return { default: file.default, agents: { ...file.agents, [key.slice("agent:".length)]: id.toLowerCase() } };
}

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
     *  resuming an id whose transcript is gone (#1549). */
    sessionExists: (id: string) => boolean;
    /** Read the persisted `.claude-session_id` for this cwd (injected; `auto`
     *  only). Return null when absent/unreadable. */
    readPersistedId: () => string | null;
    /**
     * #2523 — `auto` only: with no session of its own to resume, start from a
     * fork of this one (the main loop's), under a new id. Ignored when the
     * loop has its own session, or when this one is gone.
     */
    forkFrom?: string | null;
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
/**
 * The `auto` resolution, on its own so the `fixed` misconfiguration fallback
 * can BE it rather than imitate it.
 *
 * Resume the persisted id only when its transcript is actually there. A
 * well-formed id is not a live one: `.aiball-session_id` sits in the project
 * cwd — deliberately, so continuity survives the state-dir wipe on restart —
 * and therefore outlives the transcript it names, because claude prunes and
 * rotates its own sessions on its own schedule. Handing claude
 * `--resume <gone>` makes it exit on the spot, which kills the pane, which
 * reaps the mux session, which stops the kernel on `watchdog:tmux-gone`: a loop
 * that refuses to start with nothing on screen to say why.
 */
function resolveAuto(
    readPersistedId: () => string | null,
    sessionExists: (id: string) => boolean,
    forkFrom: string | null = null,
): SessionResolvePlan {
    const fresh = resolveOwnAuto(readPersistedId, sessionExists);
    if (fresh.sessionId !== null || !forkFrom) return fresh;
    // #2523 — nothing of its own to resume: fork the main loop's session. The
    // SessionStart hook then records the NEW id under this loop's own entry, so
    // the next start resumes the fork, never the original.
    const source = isValidUuid(forkFrom) ? forkFrom.toLowerCase() : null;
    if (source && sessionExists(source)) {
        return { mode: "auto", sessionId: null, args: ["--resume", source, "--fork-session"], warning: fresh.warning };
    }
    const why = `--fork asked, but the main loop has no session to fork (${source ?? "none recorded"}) — starting a fresh one`;
    return { ...fresh, warning: fresh.warning ? `${fresh.warning} ; ${why}` : why };
}

function resolveOwnAuto(
    readPersistedId: () => string | null,
    sessionExists: (id: string) => boolean,
): SessionResolvePlan {
    const persisted = readPersistedId();
    if (persisted && isValidUuid(persisted)) {
        const id = persisted.toLowerCase();
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
    // First run (or file gone): pass nothing; the SessionStart hook detects the
    // id claude creates and persists it for next time.
    return { mode: "auto", sessionId: null, args: [], warning: null };
}

export function resolveSession(input: SessionResolveInput): SessionResolvePlan {
    const { mode, configuredId, loopName, sessionExists, readPersistedId } = input;

    if (mode === "legacy") {
        return { mode: "legacy", sessionId: null, args: [], warning: null };
    }

    if (mode === "auto") {
        return resolveAuto(readPersistedId, sessionExists, input.forkFrom ?? null);
    }

    let id: string;
    if (mode === "fixed") {
        const trimmed = configuredId.trim();
        if (!isValidUuid(trimmed)) {
            // Misconfigured fixed mode → fall back to auto (detect+persist)
            // rather than feed claude a bad id (which would abort the boot).
            //
            // This branch used to REBUILD auto's logic inline, and so missed
            // the existence gate auto had gained — a fallback that named auto
            // in its warning while behaving like auto before that gate. Someone
            // with a bad `session_id` AND a stale persisted id got the exact
            // silent death the gate exists to prevent, told only that things
            // were "falling back to auto". Call auto instead of imitating it:
            // there is now one implementation to keep correct, not two.
            const fallback = resolveAuto(readPersistedId, sessionExists);
            const misconfig = `claude.session_mode=fixed but claude.session_id is missing/invalid `
                + `("${configuredId}") — falling back to auto`;
            return {
                ...fallback,
                warning: fallback.warning ? `${misconfig} ; ${fallback.warning}` : misconfig,
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
