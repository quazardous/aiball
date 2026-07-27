/**
 * #739 — transport seam for the ipc-events layer. The public ipc-events
 * API (`Event`, `listenEvents`/`openEventChannel`/`sendEventOnce`) is
 * platform-agnostic ; only the ~3 transport touchpoints differ per OS
 * (how the server binds, how a client addresses it, how the addressing
 * artifact is cleaned up). Those live behind this interface so the comms
 * métier never changes.
 *
 * Two impls : `uds` (Unix domain socket, file-perm gated — the original
 * behaviour) and `win32-loopback` (127.0.0.1 ephemeral port + token,
 * because `ws` can't address an AF_UNIX path or a named pipe on Windows).
 * Loopback TCP also works on every platform, which is what lets the
 * shared transport-contract test exercise it on a Linux CI runner.
 */
import type { Server as HttpServer } from "node:http";

/** Per-server handle returned by `Transport.bind`. Closes over whatever
 *  the bind produced (e.g. the win32 token + address marker path). */
export interface TransportServer {
    /** Gate an incoming ws upgrade. `reqUrl` is the raw request URL
     *  (`/?t=…`). UDS returns true unconditionally (filesystem perms
     *  already gate access) ; loopback validates the shared token. */
    accept(reqUrl: string | undefined): boolean;
    /** Remove the addressing artifact (UDS: the socket file ; loopback:
     *  the `.addr` marker). Idempotent, best-effort. */
    cleanup(): void;
}

/** A swappable transport for the ipc-events ws layer. */
export interface Transport {
    /** Diagnostic tag (`"uds"` / `"win32-loopback"`). */
    readonly kind: string;
    /** Bind `http` for `socketPath` (cleaning any orphan artifact first)
     *  and publish its address so clients can resolve it. Returns the
     *  per-server handle (connection gate + cleanup). */
    bind(http: HttpServer, socketPath: string): TransportServer;
    /** Build the ws client URL for `socketPath`, or `null` when it can't
     *  be resolved yet (server not up / address marker absent) — the
     *  caller treats null as "not connectable", same as a refused socket. */
    clientUrl(socketPath: string): string | null;
    /**
     * Is a server plausibly listening for `socketPath`? A cheap pre-flight
     * so a caller can bail out instead of paying a connect timeout.
     *
     * #1181/#1601 — this exists because callers were rolling their own, and
     * the shape they reached for was `existsSync(loopSockPath(sd))`. That is
     * a Unix-only question: win32 never creates a socket FILE, it publishes
     * `<socketPath>.addr`. So `claude-loop inspect` and `claude-loop health`
     * both short-circuited to "down" on every Windows loop, however healthy —
     * inspect then printed its zero-value fallbacks with no indication they
     * were fallbacks, which is worse than an error: it reported `afk.mode
     * "off"` while the bar was rendering a live 496s AFK countdown.
     *
     * Answering it here means each transport states its own truth, and the
     * shared contract test checks both.
     */
    reachable(socketPath: string): boolean;
}
