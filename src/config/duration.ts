/**
 * #3138 — a duration in config: seconds on the wire, and a notation a person
 * writes and reads: `d h m s`, in that order, each unit at most once, spaces
 * allowed between parts (`90s`, `15m`, `1h30m`, `1h 30m`, `2d`). A bare
 * integer is seconds; `0` is zero. One grammar, here, that every client
 * reproduces as is (docs/CONFIGS.md).
 */

const NOTATION = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/;

/** Seconds from a notation or a number of seconds; null when it is neither. */
export function parseDuration(input: unknown): number | null {
    if (typeof input === "number") return Number.isInteger(input) && input >= 0 ? input : null;
    if (typeof input !== "string") return null;
    const s = input.trim().toLowerCase();
    if (s === "") return null;
    if (/^\d+$/.test(s)) return Number(s);
    const m = NOTATION.exec(s);
    if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
    const [d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
    return d * 86400 + h * 3600 + mi * 60 + se;
}

/** The notation for a number of seconds, largest units first: `1h30m`, `2d`, `0`. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0";
    let rest = Math.floor(seconds);
    let out = "";
    for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
        const n = Math.floor(rest / size);
        rest -= n * size;
        if (n > 0) out += `${n}${unit}`;
    }
    return out;
}
