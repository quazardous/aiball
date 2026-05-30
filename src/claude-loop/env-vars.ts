/**
 * #583 — Single source of truth for the `CL_*` environment variable names
 * read across the claude-loop wrapper. Use as `process.env[CL_ENV.STATE_DIR]`
 * (typo-safe) instead of `process.env.CL_STATE_DIR` (string-typed). Default
 * values still live where they're read (each call site stays the authority
 * on its own fallback).
 *
 * The string literal `as const` is critical — it keeps `Object.values(CL_ENV)`
 * typed as the actual env var names rather than `string[]`.
 */
export const CL_ENV = {
    // Loop identity + state
    STATE_DIR: "CL_STATE_DIR",
    NAME: "CL_NAME",
    LOG_LEVEL: "CL_LOG_LEVEL",

    // Wake / startup behavior
    CHECK_CMD: "CL_CHECK_CMD",
    INTERVAL: "CL_INTERVAL",
    WAIT: "CL_WAIT",
    NO_STARTUP_PING: "CL_NO_STARTUP_PING",
    RESUME_MODE: "CL_RESUME_MODE",
    RESUME_PICK: "CL_RESUME_PICK",
    CLAUDE_CMD: "CL_CLAUDE_CMD",
    DRAINED_STRATEGY: "CL_DRAINED_STRATEGY",
    PROXY_LOG: "CL_PROXY_LOG",

    // Grace periods (seconds)
    USER_GRACE_SEC: "CL_USER_GRACE_SEC",
    ASK_GRACE_SEC: "CL_ASK_GRACE_SEC",
    BOOT_GRACE_SEC: "CL_BOOT_GRACE_SEC",
    BOOT_MIN_SEC: "CL_BOOT_MIN_SEC",
    // #636 — timer exits after 1 heartbeat tick. For pytest harnesses.
    RUN_ONCE: "CL_RUN_ONCE",

    // Wake coalesce / mutex windows (ms)
    PANE_BUSY_DELAY_MS: "CL_PANE_BUSY_DELAY_MS",
    WAKE_IN_FLIGHT_TTL_MS: "CL_WAKE_IN_FLIGHT_TTL_MS",
    WAKE_COALESCE_WINDOW_MS: "CL_WAKE_COALESCE_WINDOW_MS",

    // Error-backoff
    ERROR_BACKOFF_BASE_MS: "CL_ERROR_BACKOFF_BASE_MS",
    ERROR_BACKOFF_FACTOR: "CL_ERROR_BACKOFF_FACTOR",
    ERROR_BACKOFF_CAP_MS: "CL_ERROR_BACKOFF_CAP_MS",
} as const;

export type ClEnvName = typeof CL_ENV[keyof typeof CL_ENV];
