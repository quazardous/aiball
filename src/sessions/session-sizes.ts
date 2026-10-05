/**
 * #3611 — the last size an agent's session had, so its next host does not
 * start at 80×24. A loop started by the daemon has no terminal to read a size
 * from: its host was born at 80×24, Claude resumed its conversation drawn at
 * that width, and a client attaching later at 152 columns found the right half
 * empty. Kept in the daemon's own folder, by agent: a restart deletes the
 * loop's state dir.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIBALL_HOME } from "../paths.js";

export interface SessionSize { rows: number; cols: number }

const file = (): string => join(AIBALL_HOME, "session-sizes.json");

function readAll(): Record<string, SessionSize> {
    try {
        const v = JSON.parse(readFileSync(file(), "utf8")) as unknown;
        return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, SessionSize> : {};
    } catch { return {}; }
}

const isSize = (s: unknown): s is SessionSize => {
    const o = s as SessionSize | null;
    return !!o && Number.isInteger(o.rows) && Number.isInteger(o.cols) && o.rows >= 4 && o.cols >= 20 && o.rows <= 1000 && o.cols <= 1000;
};

/** The size `agent`'s session last had, or null. */
export function rememberedSize(agent: string): SessionSize | null {
    const s = readAll()[agent];
    return isSize(s) ? { rows: s.rows, cols: s.cols } : null;
}

/** Keep `size` as `agent`'s; a size out of reason is ignored. */
export function rememberSize(agent: string, size: unknown): void {
    if (!isSize(size)) return;
    const all = readAll();
    const prev = all[agent];
    if (prev && prev.rows === size.rows && prev.cols === size.cols) return;
    all[agent] = { rows: size.rows, cols: size.cols };
    try {
        mkdirSync(dirname(file()), { recursive: true });
        const tmp = `${file()}.tmp`;
        writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
        renameSync(tmp, file());
    } catch { /* a size not kept costs a start at 80×24, nothing else */ }
}
