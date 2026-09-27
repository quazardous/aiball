/**
 * #3138 — the config duration notation, written back: largest units first
 * (`1h30m`, `2d`, `0`). The grammar is the daemon's (src/config/duration.ts,
 * docs/CONFIGS.md); the page only displays, the daemon parses what is typed.
 */
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
