/**
 * #3969 — the zone the board shows its times in (`display.timezone`).
 *
 * The daemon stores and compares every time in UTC (`…Z`): that does not move.
 * What an agent reads is rewritten into the board's zone, with its offset
 * (`2026-10-13T12:44:47.774+02:00`, still ISO 8601, still unambiguous), and
 * what an agent sends back is turned into UTC again before the daemon compares
 * it as a string. A human in Paris reads 12:44 CEST, not 10:44 UTC, and the
 * agents write the times they quote in that zone.
 */

/** `auto` (or empty): the zone of the machine the daemon runs on. */
export const TIMEZONE_AUTO = "auto";

/** Is `tz` a zone this runtime knows (`Europe/Paris`, `UTC`…)? */
export function isTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** A `display.timezone` value accepted by the config: `auto`, empty, or a known zone. */
export function isTimeZoneSetting(v: string): boolean {
    return v === "" || v === TIMEZONE_AUTO || isTimeZone(v);
}

/** The zone a setting stands for, canonical (`europe/paris` → `Europe/Paris`). An unknown one falls back to `auto`. */
export function resolveTimeZone(setting: unknown): string {
    if (typeof setting === "string" && setting !== "" && setting !== TIMEZONE_AUTO && isTimeZone(setting)) {
        return new Intl.DateTimeFormat("en-US", { timeZone: setting }).resolvedOptions().timeZone;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const isUtcZone = (tz: string): boolean => tz === "UTC" || tz === "Etc/UTC" || tz === "Etc/GMT" || tz === "GMT";

/** The wall clock of `ms` in `tz`, and its offset from UTC in minutes. */
function wallClock(ms: number, tz: string): { y: string; mo: string; d: string; h: string; mi: string; s: string; offsetMin: number } {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offsetMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
    return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second, offsetMin };
}

function formatOffset(min: number): string {
    const sign = min < 0 ? "-" : "+";
    const a = Math.abs(min);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

const UTC_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z$/;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?[+-]\d{2}:\d{2}$/;

/** A UTC ISO time (`…Z`) in `tz`, with its offset; anything else as it is. In UTC it stays `…Z`. */
export function toZoneIso(iso: string, tz: string): string {
    const m = UTC_ISO.exec(iso);
    if (!m || isUtcZone(tz)) return iso;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    const w = wallClock(ms, tz);
    return `${w.y}-${w.mo}-${w.d}T${w.h}:${w.mi}:${w.s}${m[2] ?? ""}${formatOffset(w.offsetMin)}`;
}

/** An ISO time with an offset, in UTC (`…Z`); anything else as it is. */
export function toUtcIso(v: string): string {
    if (!OFFSET_ISO.test(v)) return v;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
}

/** Every UTC ISO time in `value` (deep), rewritten into `tz`. Returns a copy; other values are kept. */
export function rewriteTimes<T>(value: T, tz: string): T {
    if (isUtcZone(tz)) return value;
    const walk = (v: unknown): unknown => {
        if (typeof v === "string") return UTC_ISO.test(v) ? toZoneIso(v, tz) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(value) as T;
}

/** The zone's short name at `ms`: `CEST`, `EDT`, `UTC`, or `UTC+05:30` when it has none. */
export function zoneAbbrev(ms: number, tz: string): string {
    if (isUtcZone(tz)) return "UTC";
    for (const locale of ["en-US", "en-GB"]) {
        const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" })
            .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value;
        if (name && !/^(GMT|UTC)/.test(name)) return name;
    }
    return `UTC${formatOffset(wallClock(ms, tz).offsetMin)}`;
}

/** `2026-10-13 12:44 CEST`: a time for a sentence, in `tz`, named. */
export function formatZoned(ms: number, tz: string): string {
    const w = wallClock(ms, tz);
    return `${w.y}-${w.mo}-${w.d} ${w.h}:${w.mi} ${zoneAbbrev(ms, tz)}`;
}

/** One line telling an agent which zone to write its times in. */
export function timeZoneNote(tz: string, nowMs: number = Date.now()): string {
    const off = isUtcZone(tz) ? "" : `, UTC${formatOffset(wallClock(nowMs, tz).offsetMin)}`;
    return `Times are in ${tz} (${zoneAbbrev(nowMs, tz)}${off}): write the times you quote to the human in that zone, with its abbreviation (e.g. ${formatZoned(nowMs, tz).slice(11)}).`;
}

/**
 * The board's zone as a client reads it (`config.get`), kept a minute: a loop
 * or an MCP server asks once, not on every call. Unreachable or older daemon:
 * this machine's zone.
 */
export function boardTimeZone(fetch: () => Promise<{ timezone?: string } | null | undefined>, ttlMs = 60_000): () => Promise<string> {
    let cached: { tz: string; until: number } | null = null;
    return async () => {
        const now = Date.now();
        if (cached && now < cached.until) return cached.tz;
        let tz: string;
        try {
            const r = await fetch();
            tz = typeof r?.timezone === "string" && isTimeZone(r.timezone) ? r.timezone : resolveTimeZone(TIMEZONE_AUTO);
        } catch {
            tz = resolveTimeZone(TIMEZONE_AUTO);
        }
        cached = { tz, until: now + ttlMs };
        return tz;
    };
}
