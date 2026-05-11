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
