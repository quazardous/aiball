/**
 * #3425 — reaching a session host's socket (`attach.sock`, `control.sock`) on
 * every system. The contract names a path either way (docs/SESSION-HOST.md).
 * On Unix it is a Unix socket, opened as it is, with nothing more said. On
 * Windows the host listens on the loopback and writes `{ port, token }` to
 * `<path>.addr`: the client connects to that port and says the token — in its
 * `hello` on attach, as `host.auth` on control, before anything else.
 */
import { existsSync, readFileSync } from "node:fs";
import { connect, Socket } from "node:net";

export interface HostAddress {
    port: number;
    token: string;
}

/** The address file beside a host's socket path. */
export function addressFile(socketPath: string): string {
    return `${socketPath}.addr`;
}

/** What `<path>.addr` says, when it says a port and a token; null otherwise. */
export function readHostAddress(socketPath: string): HostAddress | null {
    try {
        const v = JSON.parse(readFileSync(addressFile(socketPath), "utf8")) as { port?: unknown; token?: unknown };
        const port = typeof v.port === "number" && Number.isInteger(v.port) && v.port > 0 && v.port < 65536 ? v.port : null;
        const token = typeof v.token === "string" && v.token ? v.token : null;
        return port && token ? { port, token } : null;
    } catch {
        return null;
    }
}

/**
 * Whether a host's socket is there: the socket file on Unix, a readable
 * address on Windows, where nothing is at the path itself. Its host may still
 * have gone without removing it; this only says whether there is one to try.
 */
export function hostSocketPresent(socketPath: string, platform: NodeJS.Platform = process.platform): boolean {
    return platform === "win32" ? readHostAddress(socketPath) !== null : existsSync(socketPath);
}

/** A connection to a host's socket, and the token to say on it (null on Unix). */
export interface HostConnection {
    socket: Socket;
    token: string | null;
}

/**
 * Connect to a host's socket. On Windows, without a readable address file the
 * socket fails as a missing Unix socket does (an `error`, `ENOENT`), so the
 * callers' handling stays the same.
 */
export function connectHost(socketPath: string, platform: NodeJS.Platform = process.platform): HostConnection {
    if (platform !== "win32") return { socket: connect(socketPath), token: null };
    const addr = readHostAddress(socketPath);
    if (!addr) {
        const socket = new Socket();
        const e = Object.assign(new Error(`no session host at ${socketPath} (no address in ${addressFile(socketPath)})`), { code: "ENOENT" });
        setImmediate(() => socket.destroy(e));
        return { socket, token: null };
    }
    const socket = connect({ port: addr.port, host: "127.0.0.1" });
    socket.setNoDelay(true);
    return { socket, token: addr.token };
}

/**
 * The line a controller sends first when the host has a token: `host.auth`,
 * as a notification (no id, so no answer to sort out from the caller's own
 * calls). A wrong token ends the connection. Nothing, on Unix: the wire there
 * is what it always was.
 */
export function controlAuthLine(token: string | null): string {
    return token ? `${JSON.stringify({ jsonrpc: "2.0", method: "host.auth", params: { token } })}\n` : "";
}

/** A `hello` for the attach socket, with the token when the host has one. */
export function withToken<T extends object>(hello: T, token: string | null): T & { token?: string } {
    return token ? { ...hello, token } : hello;
}
