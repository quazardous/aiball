import { readdirSync, readFileSync, renameSync, unlinkSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { SPOOL_DIR, SPOOL_FAILED_DIR, ensureDirs } from "./paths.js";
import { submitMessage, validateNewMessage } from "./messages.js";

function isSpoolFile(name: string): boolean {
    return name.endsWith(".json") && !name.startsWith(".");
}

function processOne(filename: string): void {
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
    const v = validateNewMessage(parsed);
    if ("error" in v) {
        moveToFailed(full, filename, v.error);
        return;
    }
    try {
        submitMessage(v);
        unlinkSync(full);
    } catch (e) {
        moveToFailed(full, filename, `submit failed: ${(e as Error).message}`);
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
export function drainSpool(): number {
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
        processOne(f);
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
export function watchSpool(): void {
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
                drainSpool();
            }
        }, 100);
    };
    try {
        const w = watch(SPOOL_DIR, (_event, filename) => {
            if (filename && isSpoolFile(filename)) trigger();
        });
        w.on("error", (e) => console.warn("[spool] watch error:", e.message));
    } catch (e) {
        console.warn("[spool] watch unavailable:", (e as Error).message);
    }
}
