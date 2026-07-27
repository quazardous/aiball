/**
 * #739 — UDS transport (Unix). The original ipc-events behaviour, now
 * behind the seam: bind on a filesystem path, address it via the
 * `ws+unix://` scheme, clean up the socket file. Zero behaviour change
 * for Unix — file permissions gate access, so `accept` is unconditional.
 */
import { existsSync, unlinkSync } from "node:fs";
import type { Transport } from "./types.js";

export const udsTransport: Transport = {
    kind: "uds",
    bind(http, socketPath) {
        // Clean an orphan socket file from a previous run before binding.
        // Race-safe: if it vanished between exists & unlink we ignore —
        // `listen` surfaces a real bind error to the caller's error handler.
        try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* race */ }
        http.listen({ path: socketPath });
        return {
            accept: () => true, // filesystem perms already gate UDS access
            cleanup() {
                try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
            },
        };
    },
    reachable(socketPath) {
        // The socket file IS the address on Unix: no file, no server.
        return existsSync(socketPath);
    },
    clientUrl(socketPath) {
        // `ws+unix:` scheme : socket path, then `:` + the http path. `ws`
        // uses the socket path to connect, the http path for the upgrade.
        return `ws+unix://${socketPath}:/`;
    },
};
