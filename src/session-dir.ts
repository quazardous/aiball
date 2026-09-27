/**
 * #3141 — where a session's host keeps its sockets, under `$AIBALL_HOME/hosts`:
 * `<agent>` for an agent's, `term-<name>` for a named one. A Unix socket path
 * is capped (about 100 bytes here), so when that folder would make one too
 * long, it takes a short name from a hash of the key (`a-<8 hex>`,
 * `term-<8 hex>`); the key itself is in the host's `host.json`. Shared by the
 * daemon (src/sessions/hosts.ts) and claude-loop (src/claude-loop/host-alive.ts),
 * which must find the same folder.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

/** The longest socket path this machine's Unix sockets take (with room to spare). */
export const MAX_SOCKET_PATH = 100;

export function hostDirName(key: { agent?: string | null; name?: string | null }, hostsRoot: string): string {
    const plain = key.agent ? key.agent : `term-${key.name}`;
    // control.sock is the longest of the host's socket names.
    if (join(hostsRoot, plain, "control.sock").length <= MAX_SOCKET_PATH) return plain;
    const hash = createHash("sha256").update(plain).digest("hex").slice(0, 8);
    return `${key.agent ? "a" : "term"}-${hash}`;
}
