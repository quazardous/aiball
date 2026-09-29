/**
 * The machine secret: how a client on this machine proves it runs as the same
 * user over TCP, where the Unix socket cannot be used (Windows listens on TCP
 * only).
 *
 * The daemon writes it once into its data directory, readable by the user
 * alone (`0600`; on Windows, the profile's permissions). A client that can read
 * it is the same user, which is exactly what the socket's file mode proves. A
 * TCP call bearing it, from the loopback, is then treated as a local call:
 * `caller.machine === "local"`, the identity read from `x-aiball-consumer`.
 *
 * Both conditions matter. The secret is the proof; the loopback check keeps a
 * copied secret useless from another host. The loopback alone proves nothing:
 * another user of the machine reaches it too, and so does anything a local
 * reverse proxy (`tailscale serve`) forwards there.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "./paths.js";

export const MACHINE_SECRET_PATH = join(AIBALL_HOME, "machine-secret");

/** Every machine secret starts with this: it never collides with a token (`aiball-<hex>`). */
export const MACHINE_SECRET_PREFIX = "aiball-machine-";
const SHAPE = /^aiball-machine-[0-9a-f]{64}$/;

/** The secret on disk, or null when absent or malformed. */
export function readMachineSecret(path: string = MACHINE_SECRET_PATH): string | null {
    try {
        const s = readFileSync(path, "utf8").trim();
        return SHAPE.test(s) ? s : null;
    } catch {
        return null;
    }
}

/**
 * The secret, created on first use. Kept across restarts: clients read it once
 * and must not be cut off by a daemon restart. Written exclusively (`wx`), so
 * two daemons starting together settle on one.
 */
export function ensureMachineSecret(path: string = MACHINE_SECRET_PATH): string {
    const existing = readMachineSecret(path);
    if (existing) return existing;
    const secret = `${MACHINE_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
    try {
        writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
        return secret;
    } catch {
        // Another process wrote it first (or a malformed file is in the way): its copy wins.
        const other = readMachineSecret(path);
        if (other) return other;
        writeFileSync(path, `${secret}\n`, { mode: 0o600 });
        return secret;
    }
}

/** Does this bearer look like a machine secret (so it must not reach the token table)? */
export function looksLikeMachineSecret(token: string): boolean {
    return token.startsWith(MACHINE_SECRET_PREFIX);
}

/** Is this bearer the machine secret? Constant-time, read fresh from disk. */
export function isMachineSecret(token: string, path: string = MACHINE_SECRET_PATH): boolean {
    const secret = readMachineSecret(path);
    if (!secret) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** A peer address on this machine's loopback (IPv4 127/8, IPv6 ::1, IPv4-mapped). */
export function isLoopback(ip: string | null | undefined): boolean {
    if (!ip) return false;
    const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** A caller of this machine: the Unix socket, or the machine secret over the loopback. */
export function isMachineLocal(caller: { transport: string; machine?: string }): boolean {
    return caller.transport === "uds" || caller.machine === "local";
}
