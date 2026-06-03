/**
 * #739 — transport selection + re-exports. `ipc-events.ts` imports the
 * platform default via `selectTransport()`; the individual impls are
 * re-exported so the shared transport-contract test can drive each one
 * through the real ipc-events code path.
 */
import { udsTransport } from "./uds.js";
import { win32Transport } from "./win32.js";
import type { Transport } from "./types.js";

export type { Transport, TransportServer } from "./types.js";
export { udsTransport } from "./uds.js";
export { win32Transport } from "./win32.js";

/** The transport for the current platform. Win32 has no usable AF_UNIX
 *  path for `ws`, so it uses loopback TCP; every other platform keeps the
 *  UDS transport (file-perm gated, zero behaviour change). */
export function selectTransport(): Transport {
    return process.platform === "win32" ? win32Transport : udsTransport;
}
