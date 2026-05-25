// #422 — pure classification of a consumer's transport into "remote". ZERO
// imports on purpose so it unit-tests without a DB (façon assignment-gate.ts).
//
// `via` = the transport the consumer was last seen on (uds | tcp | node), `ip` =
// the peer address for tcp/node. A consumer is REMOTE when it reached the daemon
// from elsewhere: relayed by a proxy node (always remote), or directly over TCP
// from a non-loopback address. UDS (same-uid) and loopback TCP are local.
// Unknown via (pre-#422 / never tracked) → not remote.

export type SeenVia = "uds" | "tcp" | "node";

/** Loopback / same-host address? Handles IPv4, IPv6 `::1` and `::ffff:` mapped. */
export function isLoopbackAddr(ip: string | null | undefined): boolean {
    if (!ip) return false;
    const s = ip.replace(/^::ffff:/i, "");
    return s === "::1" || s === "localhost" || s.startsWith("127.");
}

/** Is a consumer last seen via `via`/`ip` REMOTE (off-host)? */
export function isRemoteConsumer(via: string | null | undefined, ip: string | null | undefined): boolean {
    if (via === "node") return true; // proxy-relayed → always remote
    if (via === "tcp") return !isLoopbackAddr(ip); // direct TCP from a non-loopback peer
    return false; // uds / unknown → local
}
