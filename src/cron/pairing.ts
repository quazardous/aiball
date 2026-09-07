/**
 * #2084 — the node finishes its own pairing.
 *
 * The rules and the consuming live in `node-pairing-collect.ts`; this is the
 * timer, the log, and the restart. A granted pairing has to end in a restart:
 * proxy mode is decided in `createApp()`, which replaces the whole application
 * with a forwarder — not something that can be swapped in place.
 *
 * The restart is the part david had to authorise, and it is bounded by design:
 * it happens only when a marker written by an explicit `aiball proxy pair` on
 * THIS machine turns out to have been approved by a human on the hub. Two
 * deliberate gestures, one of them on this very host, precede it.
 */
import { collectPendingPairing } from "../node-pairing-collect.js";
import { restartViaSupervisor } from "../supervisor-restart.js";

export async function runPairingCollect(): Promise<void> {
    const r = await collectPendingPairing();
    switch (r.kind) {
        case "none":
        case "waiting":
            return;
        case "already-configured":
            console.log("[pairing] a proxy is already configured — dropped the leftover request");
            return;
        case "over":
            console.log(`[pairing] request ${r.code} is over: ${r.reason}. Run \`aiball proxy pair\` again to ask afresh.`);
            return;
        case "unreachable":
            // Kept on purpose: a hub that is briefly unreachable is exactly
            // what a retry is for. Nothing else in this file is retried.
            console.warn(`[pairing] could not reach the hub for request ${r.code} (${r.error}) — will try again`);
            return;
        case "configured":
            console.log(`[pairing] request ${r.code} was approved → relaying to ${r.url}. Restarting to apply.`);
            if (!restartViaSupervisor()) {
                console.warn(
                    "[pairing] the proxy config is written, but this daemon isn't under a systemd user "
                    + "service so it could not restart itself. Restart it the way you launched it.",
                );
            }
            return;
    }
}
