// #412 / #944 — minimal PSR-3 / RFC 5424 level logger. Levels are
// filtered by a configured threshold (env `CL_LOG_LEVEL`, default
// `info`) ; anything below the threshold is dropped before formatting
// (cheap). #944 Slice 2 : emits **NDJSON** (one JSON object per line) :
//
//     {"ts":"<ISO>","level":"info","tag":"<tag>","msg":"<msg>"}
//
// `tag` is omitted when the logger was built untagged. Future structured
// fields (`{ts, level, tag, msg, meta:{phrase, atMs, ...}}`) land via an
// optional `meta` arg in a follow-up.
//
// One factory covers the existing sinks : timer.log (tag
// `claude-loop:<name>`, stdout), restart.log (tag `<name>`, file
// append), stop-hook.log (tag `stop-hook:<name>`, UDS+file). Roll-your-
// own (no dep) — surface is tiny and the format is ours.

import { loopConfig } from "./claude-loop/loop-config.js";

export const LEVELS = [
    "debug", "info", "notice", "warning", "error", "critical", "alert", "emergency",
] as const;
export type LogLevel = (typeof LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
    debug: 0, info: 1, notice: 2, warning: 3, error: 4, critical: 5, alert: 6, emergency: 7,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Parse a level name (case-insensitive). Returns null on anything unknown. */
export function parseLevel(s: string | null | undefined): LogLevel | null {
    if (!s) return null;
    const v = s.trim().toLowerCase();
    return (LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : null;
}

// Threshold resolution: explicit setLevel() override > CL_LOG_LEVEL env >
// default. Read per call so a late env change (or setLevel in a test) applies.
let override: LogLevel | null = null;

/** Force the threshold programmatically (tests / a `--log-level` flag). */
export function setLevel(level: LogLevel | string | null): void {
    override = typeof level === "string" ? parseLevel(level) : level;
}

/** The effective minimum level right now. */
export function currentLevel(): LogLevel {
    return override ?? parseLevel(loopConfig().claude_loop.log_level) ?? DEFAULT_LOG_LEVEL;
}

/** Would a message at `level` be emitted under the current threshold? Use to
 *  guard expensive message construction on hot debug paths. */
export function isEnabled(level: LogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[currentLevel()];
}

export interface Logger {
    debug(msg: string): void;
    info(msg: string): void;
    notice(msg: string): void;
    warning(msg: string): void;
    error(msg: string): void;
    critical(msg: string): void;
    alert(msg: string): void;
    emergency(msg: string): void;
    /** Generic form — `log.log("warning", msg)`. */
    log(level: LogLevel, msg: string): void;
    /** True if `level` passes the current threshold (guard helper). */
    enabled(level: LogLevel): boolean;
}

export interface LoggerOpts {
    /** Component tag rendered as `[<tag>] `. Omit for an untagged sink. */
    tag?: string;
    /** Line sink. Default: `process.stdout.write`. (e.g. a file appender.) */
    write?: (line: string) => void;
}

/** A single emitted record. Shape stable for downstream parsers
 *  (`claude-loop log`, jq pipelines). */
export interface LogRecord {
    ts: string;
    level: LogLevel;
    tag?: string;
    msg: string;
}

/** Build a level logger for one sink. */
export function createLogger(opts: LoggerOpts = {}): Logger {
    const sink = opts.write ?? ((line: string): void => {
        process.stdout.write(line);
    });
    const emit = (level: LogLevel, msg: string): void => {
        if (!isEnabled(level)) return; // below threshold → dropped before format
        const rec: LogRecord = { ts: new Date().toISOString(), level, msg };
        if (opts.tag) rec.tag = opts.tag;
        sink(`${JSON.stringify(rec)}\n`);
    };
    return {
        debug: (m) => emit("debug", m),
        info: (m) => emit("info", m),
        notice: (m) => emit("notice", m),
        warning: (m) => emit("warning", m),
        error: (m) => emit("error", m),
        critical: (m) => emit("critical", m),
        alert: (m) => emit("alert", m),
        emergency: (m) => emit("emergency", m),
        log: (level, m) => emit(level, m),
        enabled: (level) => isEnabled(level),
    };
}
