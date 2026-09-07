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
    /** After this, the hub will not grant it — stop asking. */
    expires_at: string;
    /** #394: don't inject the node token; every request carries its own. */
    strict?: boolean;
    created_at: string;
}

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

/** Whether the hub can still grant this. Past it, the marker is a leftover. */
export function isPairingRequestLive(m: PairingRequestMarker, nowMs: number = Date.now()): boolean {
    const t = Date.parse(m.expires_at);
    return Number.isFinite(t) ? t > nowMs : false;
}
