/**
 * #739 — loopback-TCP transport (Windows). `ws` can't address an AF_UNIX
 * path or a named pipe on win32 (the `ws+unix` scheme is special-cased for
 * UDS; `http.listen({path})` maps a filesystem path to a named pipe that
 * fails), but it speaks `ws://127.0.0.1:<port>` natively. So the server
 * binds an ephemeral port on the loopback interface and publishes
 * `{ port, token }` to `<socketPath>.addr` (mode 0600) ; clients read that
 * marker to resolve the URL.
 *
 * Loopback TCP is reachable by ANY local process, unlike a perm-restricted
 * UDS file — so a per-server random `token` gates access: the client echoes
 * it in the upgrade query (`?t=…`) and the server rejects a mismatch. This
 * keeps the trust surface equivalent to UDS file perms on a single-user box.
 *
 * Cross-platform by construction (loopback works everywhere), which lets the
 * shared transport-contract test exercise this impl on a Linux CI runner.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Transport } from "./types.js";

/** The address marker sits beside the would-be socket path. */
const addrPath = (socketPath: string): string => `${socketPath}.addr`;

/** Extract the `t` token from a raw request URL (`/?t=…`). */
function tokenFromUrl(reqUrl: string | undefined): string | null {
    if (!reqUrl) return null;
    const q = reqUrl.indexOf("?");
    if (q < 0) return null;
    return new URLSearchParams(reqUrl.slice(q + 1)).get("t");
}

export const win32Transport: Transport = {
    kind: "win32-loopback",
    bind(http, socketPath) {
        const marker = addrPath(socketPath);
        try { if (existsSync(marker)) unlinkSync(marker); } catch { /* race */ }
        const token = randomBytes(18).toString("base64url");
        http.listen({ port: 0, host: "127.0.0.1" }, () => {
            // Port is OS-assigned (0) — read it back once listening, then
            // publish so clients can resolve the URL. The `0600` mode keeps
            // the token readable only by the owner (trust parity with UDS).
            const addr = http.address() as AddressInfo | null;
            const port = addr && typeof addr === "object" ? addr.port : 0;
            try { writeFileSync(marker, JSON.stringify({ port, token }), { mode: 0o600 }); }
            catch { /* best-effort — clients fail to resolve, treated as down */ }
        });
        return {
            accept(reqUrl) { return tokenFromUrl(reqUrl) === token; },
            cleanup() {
                try { if (existsSync(marker)) unlinkSync(marker); } catch { /* ignore */ }
            },
        };
    },
    clientUrl(socketPath) {
        try {
            const { port, token } = JSON.parse(readFileSync(addrPath(socketPath), "utf8")) as {
                port?: number;
                token?: string;
            };
            if (!port || !token) return null;
            return `ws://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
        } catch {
            return null; // marker missing/unreadable → server not up yet
        }
    },
};
