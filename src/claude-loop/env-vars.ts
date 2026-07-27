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
    TMUX: "CL_TMUX",
    PINGS: "CL_PINGS",
    LOG_LEVEL: "CL_LOG_LEVEL",

    // Wake / startup behavior
    CHECK_CMD: "CL_CHECK_CMD",
    INTERVAL: "CL_INTERVAL",
    WAIT: "CL_WAIT",
    NO_STARTUP_PING: "CL_NO_STARTUP_PING",
    RESUME_MODE: "CL_RESUME_MODE",
    RESUME_PICK: "CL_RESUME_PICK",
    CLAUDE_CMD: "CL_CLAUDE_CMD",
    PROXY_IMPL: "CL_PROXY_IMPL",
    DRAINED_STRATEGY: "CL_DRAINED_STRATEGY",
    ESC_TAKEOVER: "CL_ESC_TAKEOVER",

    // AFK detection (PTY proxy driven)
    AFK_SPEC: "CL_AFK_SPEC",
    AFK_WINDOW_MS: "CL_AFK_WINDOW_MS",
    AFK_KEY_DISP: "CL_AFK_KEY_DISP",
    AFK_LABEL_FG_DIM: "CL_AFK_LABEL_FG_DIM",
    AFK_LABEL_FG_LIT: "CL_AFK_LABEL_FG_LIT",

    // Grace periods (seconds)
    BOOT_GRACE_SEC: "CL_BOOT_GRACE_SEC",
    BOOT_MIN_SEC: "CL_BOOT_MIN_SEC",
    // #872 Phase 3 — BOOT_GRACE_TAIL_MS retired. The XState BootMachine's
    // WATCHER_TICK deadline push (= push to now+10s on each "still booting"
    // observation) replaces the post-bootEnded tail grace ; same semantic,
    // single-source-of-truth path.
    // #636 — timer exits after 1 heartbeat tick. For pytest harnesses.
    RUN_ONCE: "CL_RUN_ONCE",

    // Wake coalesce / mutex windows (ms)
    PANE_BUSY_DELAY_MS: "CL_PANE_BUSY_DELAY_MS",
    WAKE_IN_FLIGHT_TTL_MS: "CL_WAKE_IN_FLIGHT_TTL_MS",
    WAKE_COALESCE_WINDOW_MS: "CL_WAKE_COALESCE_WINDOW_MS",
    // #999 — drain tempo (seconds). The single periodic drain cadence
    // (turn:settled re-arm = the `📨Ns` countdown). Default 10.
    WAKE_TEMPO_SEC: "CL_WAKE_TEMPO_SEC",
    // #786 — backlog wake cooldown (seconds). The loop sends this to the
    // daemon's ?backlog=1 filter; a ticket the loop just named won't
    // surface again until the cooldown elapses OR someone replies on it.
    // Default 3600 (1h).
    BACKLOG_COOLDOWN_SEC: "CL_BACKLOG_COOLDOWN_SEC",

    // #722 — input-hot probe + pane-probe cadence (2 rates: fast/slow)
    INPUT_HOT_TTL_MS: "CL_INPUT_HOT_TTL_MS",
    PANE_PROBE_FAST_MS: "CL_PANE_PROBE_FAST_MS",
    PANE_PROBE_SLOW_MS: "CL_PANE_PROBE_SLOW_MS",

    // Error-backoff
    ERROR_BACKOFF_BASE_MS: "CL_ERROR_BACKOFF_BASE_MS",
    ERROR_BACKOFF_FACTOR: "CL_ERROR_BACKOFF_FACTOR",
    ERROR_BACKOFF_CAP_MS: "CL_ERROR_BACKOFF_CAP_MS",

    // #1116 Slice 2 — API-unreachable wake-hold TTL (ms). Past this window
    // the wake gate FAILS OPEN (wakes resume) so a terminal 10/10 retry
    // failure or a detection false-positive can never freeze the loop.
    // Default 120000 (2 min).
    API_UNREACHABLE_TTL_MS: "CL_API_UNREACHABLE_TTL_MS",

    // Debug-only opt-in logs (no yaml backing — set via shell env at start
    // or `claude-loop reload --set …`). Reads are gated on `=== "1"`.
    PROXY_LOG: "CL_PROXY_LOG",
    PROXY_DEBUG_TTY: "CL_PROXY_DEBUG_TTY",
    BAR_PAINT_LOG: "CL_BAR_PAINT_LOG",
    PANE_CAPTURE_LOG: "CL_PANE_CAPTURE_LOG",
    // #1588 — the cache size, in FRAMES. Overrides `claude_loop.pane_cache_frames`
    // for one run. Replaces `CL_PANE_CAPTURE_WINDOW_MIN`: rotating on age meant
    // a busy loop and an idle one kept wildly different amounts of evidence,
    // and "keep the last N screens" is what someone reading the corpus wants.
    PANE_CAPTURE_FRAMES: "CL_PANE_CAPTURE_FRAMES",
    // Unified record/replay capture (supersedes the scattered debug logs
    // above). `CL_CAPTURE=1` writes one NDJSON file per writer-process into
    // `<state_dir>/capture/` (timer → `panes.ndjson`, proxy → `proxy.ndjson`),
    // sharing one epoch clock so a real session can be merged + replayed.
    CAPTURE: "CL_CAPTURE",
} as const;

export type ClEnvName = typeof CL_ENV[keyof typeof CL_ENV];
