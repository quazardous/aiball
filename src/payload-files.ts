/**
 * #2454 — the files a payload travels through, shared by `aiball payload` and
 * the MCP payload tools. A secret enters the board from a file and leaves it
 * into a file: never through a command line, a tool argument, a tool answer or
 * a terminal. What lives here:
 *
 * - reading a deposit: a JSON object of key → value, refused without echoing a
 *   byte of its content;
 * - writing a dump: JSON replaces the file, but an `env` dump MERGES into an
 *   existing file — it replaces or appends its own keys and leaves every other
 *   line alone. It used to rewrite the whole file, so dumping one key into a
 *   service's `.env.local` erased the keys already there (seen live on a
 *   deploy target's env file).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export type DumpFormat = "json" | "env";

/** The value as it lands after `KEY=`. */
function envValue(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
}

/** A whole env file for this payload, one `KEY=value` per line. */
export function renderEnv(payload: Record<string, unknown>): string {
    return Object.entries(payload).map(([k, v]) => `${k}=${envValue(v)}`).join("\n") + "\n";
}

/**
 * Merge `payload` into the text of an existing env file: each key's first
 * assignment line (`KEY=…` or `export KEY=…`) takes the new value, later
 * duplicates of that key are dropped, and keys the file did not have are
 * appended at the end. Comments, blank lines and other keys stay as they were.
 */
export function mergeEnv(existing: string, payload: Record<string, unknown>): string {
    const pending = new Map(Object.entries(payload));
    const seen = new Set<string>();
    const lines = existing.length === 0 ? [] : existing.replace(/\n$/, "").split("\n");
    const out: string[] = [];
    for (const line of lines) {
        const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!m || !Object.prototype.hasOwnProperty.call(payload, m[2])) {
            out.push(line);
            continue;
        }
        const key = m[2];
        if (seen.has(key)) continue; // a duplicate would silently win later — drop it
        seen.add(key);
        out.push(`${m[1]}${key}=${envValue(payload[key])}`);
        pending.delete(key);
    }
    for (const [key, value] of pending) out.push(`${key}=${envValue(value)}`);
    return out.join("\n") + "\n";
}

export interface DumpWritten {
    path: string;
    format: DumpFormat;
    /** The key NAMES written — never their values. */
    keys: string[];
    /** true when an existing env file was merged into rather than created. */
    merged: boolean;
}

/** Write a dump to `path` with mode 0600; `env` merges into an existing file. */
export function writeDumpFile(path: string, payload: Record<string, unknown>, format: DumpFormat): DumpWritten {
    const merged = format === "env" && existsSync(path);
    const text = format === "json"
        ? JSON.stringify(payload, null, 2) + "\n"
        : merged ? mergeEnv(readFileSync(path, "utf8"), payload) : renderEnv(payload);
    writeFileSync(path, text, { mode: 0o600 });
    // An existing file keeps its own permissions: the `mode` above only applies
    // to a file we created.
    chmodSync(path, 0o600);
    return { path, format, keys: Object.keys(payload), merged };
}

/**
 * Read a deposit file: a JSON object of key → value. The errors name the file
 * and what is wrong with its SHAPE, never its content — a half-valid secret file
 * must not be echoed back into a terminal or a tool answer.
 */
export function readDepositFile(path: string): Record<string, unknown> {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        throw new Error(`cannot read ${path}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${path} is not valid JSON (content not shown)`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${path} must hold a JSON object of key -> value (content not shown)`);
    }
    return parsed as Record<string, unknown>;
}
