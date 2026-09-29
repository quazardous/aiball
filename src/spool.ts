import { readdirSync, readFileSync, renameSync, unlinkSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { SPOOL_DIR, SPOOL_FAILED_DIR, ensureDirs } from "./paths.js";
import { callerOf, callMethod, Refusal } from "./bus/methods.js";
import "./bus/register.js";

/** The file `aiball drain` touches to wake the watcher: not a spooled write, so
 *  never read as one, but a reason to drain now (#3299). */
export const DRAIN_TRIGGER = ".drain-trigger";

function isSpoolFile(name: string): boolean {
    return name.endsWith(".json") && !name.startsWith(".");
}

/**
 * #3245 — a spooled write replays as the bus's `message.post`, for its author
 * on the local socket (the spool is written by this machine's clients): the
 * same guards as a live post (author, commits, handback, decisions, platform
 * tag), and its idempotency key makes a write that had in fact gone through
 * answer with the message it made instead of posting it twice.
 */
async function processOne(filename: string): Promise<void> {
    const full = join(SPOOL_DIR, filename);
    let raw: string;
    try {
        raw = readFileSync(full, "utf8");
    } catch {
        return; // file disappeared (concurrent drain) — skip
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        moveToFailed(full, filename, `invalid JSON: ${(e as Error).message}`);
        return;
    }
    const msg = parsed as Record<string, unknown> | null;
    const author = typeof msg?.by_agent === "string" && msg.by_agent ? msg.by_agent : null;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || !author) {
        moveToFailed(full, filename, "not a message with its author (by_agent)");
        return;
    }
    try {
        await callMethod(callerOf({ consumer_id: author, token_kind: "agent", transport: "uds", token: null }), "message.post", msg);
        unlinkSync(full);
    } catch (e) {
        moveToFailed(full, filename, e instanceof Refusal ? `refused (${e.status} ${e.code}): ${e.message}` : `submit failed: ${(e as Error).message}`);
    }
}

function moveToFailed(full: string, filename: string, reason: string): void {
    console.warn(`[spool] failed ${filename}: ${reason}`);
    try {
        renameSync(full, join(SPOOL_FAILED_DIR, filename));
    } catch {
        try { unlinkSync(full); } catch { /* swallow */ }
    }
}

/**
 * Drain everything currently in the spool dir, oldest-first.
 * Safe to call multiple times.
 */
let draining: Promise<number> | null = null;

export function drainSpool(): Promise<number> {
    // One drain at a time: a replay is async now, and two drains reading the
    // same file would post it twice (its key would answer the second, but a
    // file with no key would not).
    draining ??= drainOnce().finally(() => { draining = null; });
    return draining;
}

async function drainOnce(): Promise<number> {
    ensureDirs();
    let entries: string[];
    try {
        entries = readdirSync(SPOOL_DIR).filter(isSpoolFile);
    } catch {
        return 0;
    }
    entries.sort(); // filenames are timestamp-prefixed → chronological
    let count = 0;
    for (const f of entries) {
        const full = join(SPOOL_DIR, f);
        try {
            statSync(full);
        } catch {
            continue;
        }
        await processOne(f);
        count++;
    }
    if (count > 0) {
        console.log(`[spool] drained ${count} message(s)`);
    }
    return count;
}

/**
 * Watch the spool dir for new drops while the daemon is running.
 * Debounces to absorb rapid bursts.
 */
export function watchSpool(): { close(): void } {
    ensureDirs();
    let pending = false;
    let timer: NodeJS.Timeout | null = null;
    const trigger = () => {
        pending = true;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (pending) {
                pending = false;
                void drainSpool();
            }
        }, 100);
    };
    try {
        const w = watch(SPOOL_DIR, (_event, filename) => {
            if (filename && (isSpoolFile(filename) || filename === DRAIN_TRIGGER)) trigger();
        });
        w.on("error", (e) => console.warn("[spool] watch error:", e.message));
        return { close: () => { w.close(); if (timer) clearTimeout(timer); } };
    } catch (e) {
        console.warn("[spool] watch unavailable:", (e as Error).message);
        return { close: () => {} };
    }
}
