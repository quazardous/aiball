/**
 * Settings (k/v) — strategy + upload caps.
 *
 * Extracted from db.ts (#B.332 Phase A). Pure thin wrappers around the
 * `settings` table: the key/value pair is the contract, the typed
 * helpers below just keep callers honest about the value shape.
 */
import { eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

export type Strategy = "manual" | "auto" | "auto-reply";
export const STRATEGIES: readonly Strategy[] = ["manual", "auto", "auto-reply"];
export const DEFAULT_STRATEGY: Strategy = "auto-reply";

export function getSetting(key: string): string | null {
    const r = getDb().select({ value: schema.settings.value })
        .from(schema.settings).where(eq(schema.settings.key, key)).get();
    return r?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    getDb().insert(schema.settings).values({ key, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .run();
}

export function getStrategy(): Strategy {
    const v = getSetting("strategy");
    if (v && (STRATEGIES as readonly string[]).includes(v)) return v as Strategy;
    return DEFAULT_STRATEGY;
}

export function setStrategy(s: Strategy): void {
    setSetting("strategy", s);
}

// Per-project strategy override (#B.127). Stored in the same k/v
// `settings` table under `strategy:<project>` so we don't need to
// model a `projects` table (project is still just a string column on
// tickets). `null`/missing → fall back to the global strategy.
const PROJECT_STRATEGY_PREFIX = "strategy:";

export function getProjectStrategy(project: string): Strategy | null {
    if (!project) return null;
    const v = getSetting(PROJECT_STRATEGY_PREFIX + project);
    if (v && (STRATEGIES as readonly string[]).includes(v)) return v as Strategy;
    return null;
}

export function setProjectStrategy(project: string, s: Strategy | null): void {
    if (!project) throw new Error("project required");
    const key = PROJECT_STRATEGY_PREFIX + project;
    if (s === null) {
        // Clear by deleting the row, so getProjectStrategy returns null
        // and the global strategy takes over.
        getDb().delete(schema.settings).where(eq(schema.settings.key, key)).run();
        return;
    }
    setSetting(key, s);
}

/** Effective strategy used by the rule engine: per-project override
 *  takes precedence over the global default. */
export function effectiveStrategy(project: string): Strategy {
    return getProjectStrategy(project) ?? getStrategy();
}

/** Hard cap regardless of the configured `upload_max_bytes` (50 MB).
 *  Keeps the daemon out of trouble even if the setting is corrupted
 *  or a malicious caller sets it absurdly high. */
export const UPLOAD_HARD_CAP_BYTES = 50 * 1024 * 1024;
/** Default cap shipped at install. 10 MB matches the user's preference
 *  (#B.76) and is comfortably above a typical screenshot. */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function getUploadMaxBytes(): number {
    const v = getSetting("upload_max_bytes");
    if (!v) return DEFAULT_UPLOAD_MAX_BYTES;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPLOAD_MAX_BYTES;
    return Math.min(n, UPLOAD_HARD_CAP_BYTES);
}

export function setUploadMaxBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error("upload_max_bytes must be a positive integer");
    }
    setSetting("upload_max_bytes", String(Math.min(bytes, UPLOAD_HARD_CAP_BYTES)));
}
