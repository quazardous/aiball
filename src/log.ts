// #412 — minimal PSR-3 / RFC 5424 level logger. Levels are filtered by a
// configured threshold (env `CL_LOG_LEVEL`, default `info`); anything below the
// threshold is dropped before formatting (cheap). Plain format preserved so
// `claude-loop tail` / `--log` keep working:
//
//     <ISO ts> [<tag>] <LEVEL> <msg>      (tag optional)
//
// One factory covers the three existing sinks: timer.log (tag
// `claude-loop:<name>`, stdout), restart.log (tag `<name>`, file append),
// stop-hook.log (no tag, file append). Roll-your-own (no dep) — the surface is
// tiny and the format is ours; swap for a lib later if it ever needs more.

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
    return override ?? parseLevel(process.env.CL_LOG_LEVEL) ?? DEFAULT_LOG_LEVEL;
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

/** Build a level logger for one sink. */
export function createLogger(opts: LoggerOpts = {}): Logger {
    const prefix = opts.tag ? `[${opts.tag}] ` : "";
    const sink = opts.write ?? ((line: string): void => {
        process.stdout.write(line);
    });
    const emit = (level: LogLevel, msg: string): void => {
        if (!isEnabled(level)) return; // below threshold → dropped before format
        sink(`${new Date().toISOString()} ${prefix}${level.toUpperCase()} ${msg}\n`);
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
