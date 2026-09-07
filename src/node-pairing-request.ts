/**
 * #2084 — the pairing request, remembered on the NODE.
 *
 * `aiball proxy pair` used to be a foreground vigil: it polled the hub every
 * second and only finished if you were still standing in front of the terminal
 * when a human approved. Close the window, walk away past the ten-minute TTL,
 * and the approval could land with nobody left to collect the token — which is
 * collectable exactly once. The node then knew nothing about a request that had
 * been granted.
 *
 * So the request is written down here, and the node's own daemon finishes the
 * job on its next tick. What david asked for, in his words: "le proxy va
 * automatiquement voir que sa demande est active".
 *
 * NO SECRET LIVES IN THIS FILE. The id is a handle for WATCHING a request; it
 * cannot approve one, and the token it eventually yields goes straight into the
 * proxy config. Holding this file gains an attacker nothing they could not get
 * by asking the hub for their own request.
 *
 * CONSUMING IT IS THE POINT. David: "il faut bien consommer la demande pour pas
 * avoir une boucle" — a marker that outlives its request is a daemon that
 * reconfigures and restarts itself forever. Every path out of `collect` clears
 * it: granted, refused, expired, gone, or simply already-configured.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME } from "./paths.js";

export interface PairingRequestMarker {
    /** The hub this was asked of. */
    url: string;
    /** Handle to poll with. Watching, never approving. */
    id: string;
    /** Shown so a log line can say which request this was. */
    code: string;
    /** The hub's deadline, on the HUB's clock. Display only — #2088: the hub
     *  is what decides whether a request is still live. */
    expires_at: string;
    /** #394: don't inject the node token; every request carries its own. */
    strict?: boolean;
    /** Written here, so elapsed time since it is measurable without involving
     *  the hub's clock. */
    created_at: string;
}

/** Stop polling a hub that never answers. Not an expiry — the hub owns that. */
export const PAIRING_ABANDON_AFTER_MS = 60 * 60 * 1000;

export function pairingRequestPath(): string {
    return join(AIBALL_HOME, "pairing-request.json");
}

/** Remember a request. Written atomically: a half-written marker read by the
 *  daemon a tick later would be a puzzle with no upside. */
export function savePairingRequest(m: PairingRequestMarker): void {
    const path = pairingRequestPath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
    renameSync(tmp, path);
}

/** The pending request, or null. A malformed file is treated as none AND
 *  cleared: an unreadable marker can never become readable, and leaving it
 *  would re-run this failure on every single tick. */
export function loadPairingRequest(): PairingRequestMarker | null {
    const path = pairingRequestPath();
    if (!existsSync(path)) return null;
    try {
        const m = JSON.parse(readFileSync(path, "utf8")) as PairingRequestMarker;
        if (!m || typeof m.url !== "string" || typeof m.id !== "string") {
            clearPairingRequest();
            return null;
        }
        return m;
    } catch {
        clearPairingRequest();
        return null;
    }
}

/** Consume it. Idempotent — clearing a marker that is already gone is the
 *  normal case on the path where the daemon restarts itself. */
export function clearPairingRequest(): void {
    try {
        unlinkSync(pairingRequestPath());
    } catch {
        /* already gone */
    }
}

/**
 * Whether to stop trying, having never reached the hub at all. This is NOT the
 * expiry: #2088 removed a local expiry check that compared the hub's
 * `expires_at` to this machine's clock, which made every request look expired
 * on a node whose clock ran ahead. The hub answers `expired` itself.
 *
 * An undatable marker counts as abandoned rather than immortal.
 */
export function isPairingRequestAbandoned(
    m: PairingRequestMarker,
    nowMs: number = Date.now(),
): boolean {
    const started = Date.parse(m.created_at);
    if (!Number.isFinite(started)) return true;
    return nowMs - started >= PAIRING_ABANDON_AFTER_MS;
}
