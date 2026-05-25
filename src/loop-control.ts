/**
 * #442 — remote loop control (hard-kill) authorization.
 *
 * Stopping a claude-loop remotely is a PRIVILEGED action: a malicious caller
 * could DoS an operator's loops. So it is gated to a local/direct **human
 * moderator** and explicitly DENIED to a **proxy node** token — a node token is
 * the weak link (it may assert any relayed `x-aiball-consumer`, including
 * "human", see auth.ts / docs/SECURITY.md), so trusting `isHuman` alone would
 * let a compromised node kill loops. Hence the two independent checks.
 *
 * Pure (no Express / DB) so it unit-tests in isolation.
 */
export interface LoopControlVerdict {
    ok: boolean;
    reason?: string;
}

/**
 * May a caller hard-kill a loop? `tokenKind` is the request's auth tier
 * (`agent` = UDS local-trust or a direct bearer; `node` = a proxy node token).
 * `callerIsHuman` is whether the resolved consumer is a human/moderator.
 */
export function canStopLoop(
    tokenKind: string | undefined,
    callerIsHuman: boolean,
): LoopControlVerdict {
    if (tokenKind === "node") {
        return { ok: false, reason: "proxy nodes cannot stop loops (anti-DoS — local/direct moderator only)" };
    }
    if (!callerIsHuman) {
        return { ok: false, reason: "loop control is moderator-only" };
    }
    return { ok: true };
}
