/**
 * #2084 — finishing a pairing without a human in front of the terminal.
 *
 * One function, two callers: the `proxy pair` command while it waits, and a
 * cron task on the node's daemon so the request survives the terminal being
 * closed. Both go through here so "what happens when a request is granted" has
 * exactly one definition.
 *
 * ## The loop david named
 *
 * "il faut bien consommer la demande pour pas avoir une boucle". A granted
 * pairing ends in a restart, and a restart re-runs whatever is on disk: a
 * marker that survives its request is a machine that reconfigures and bounces
 * itself forever. Two independent things prevent that, because one guard for a
 * self-restarting loop is not enough:
 *
 *   1. **Every outcome consumes the marker.** Granted, refused, expired, gone,
 *      unreadable — each path clears it before returning. Only a transient
 *      network failure leaves it, which is precisely the case worth retrying.
 *   2. **An already-configured node does nothing.** If a `proxy:` block exists,
 *      the pairing is behind us whatever the marker says; the marker is dropped
 *      and no restart is issued. This is the guard that holds even if the first
 *      one is defeated by a crash at the wrong instant, and it is the one that
 *      makes the restart loop structurally impossible rather than unlikely.
 *
 * The token is collectable exactly ONCE, which sets the order of operations:
 * write the config before consuming the marker, so a crash in between leaves a
 * marker whose next poll reads `delivered` — terminal, cleared, no loop — with
 * the config already correct. Consuming first would trade a loop for a lost
 * credential.
 */
import { loadProxy } from "./proxy.js";
import { writeProxyConfig } from "./proxy-config-write.js";
import {
    clearPairingRequest,
    isPairingRequestLive,
    loadPairingRequest,
    type PairingRequestMarker,
} from "./node-pairing-request.js";

/** What happened, so a caller can log it in its own voice. */
export type PairingCollectOutcome =
    /** Nothing was pending. */
    | { kind: "none" }
    /** A relay is already configured — the marker was a leftover. */
    | { kind: "already-configured" }
    /** Still waiting on a human. The marker stays. */
    | { kind: "waiting"; code: string }
    /** Granted: the config is written and the daemon must restart to relay. */
    | { kind: "configured"; url: string; code: string }
    /** Refused, expired, already collected, or gone. Marker consumed. */
    | { kind: "over"; reason: string; code: string }
    /** The hub could not be reached. Marker kept — this is what retries exist for. */
    | { kind: "unreachable"; error: string; code: string };

async function pollHub(m: PairingRequestMarker): Promise<{ state?: string; token?: string } | null> {
    const res = await fetch(`${m.url.replace(/\/+$/, "")}/api/nodes/enroll/${encodeURIComponent(m.id)}`);
    if (res.status === 404) return { state: "gone" };
    if (!res.ok) return null;
    return await res.json() as { state?: string; token?: string };
}

/**
 * Advance a pending pairing by one step. Never throws: a caller on a timer must
 * not be able to take the daemon down because a hub was briefly unreachable.
 */
export async function collectPendingPairing(): Promise<PairingCollectOutcome> {
    const m = loadPairingRequest();
    if (!m) return { kind: "none" };

    // Guard 2, first: being a relay already settles it, whatever the marker says.
    if (loadProxy()) {
        clearPairingRequest();
        return { kind: "already-configured" };
    }

    if (!isPairingRequestLive(m)) {
        clearPairingRequest();
        return { kind: "over", reason: "the request expired before anyone answered it", code: m.code };
    }

    let state: { state?: string; token?: string } | null;
    try {
        state = await pollHub(m);
    } catch (e) {
        return { kind: "unreachable", error: (e as Error).message, code: m.code };
    }
    if (!state) return { kind: "unreachable", error: "the hub answered with an error", code: m.code };

    if (state.state === "approved" && state.token) {
        // Config BEFORE consuming: the token is served once, so a crash here
        // must leave a marker that resolves itself, not a credential nobody has.
        writeProxyConfig({ url: m.url, token: state.token, strict: m.strict === true });
        clearPairingRequest();
        return { kind: "configured", url: m.url, code: m.code };
    }

    const over: Record<string, string> = {
        rejected: "the request was refused on the hub",
        expired: "nobody approved it in time",
        delivered: "its token was already collected",
        gone: "the hub no longer knows this request",
    };
    const reason = state.state ? over[state.state] : undefined;
    if (reason) {
        clearPairingRequest();
        return { kind: "over", reason, code: m.code };
    }
    return { kind: "waiting", code: m.code };
}
