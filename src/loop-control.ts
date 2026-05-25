/**
 * #442/#451 — remote loop control authorization (hard-kill #442, raw-prompt
 * injection #451).
 *
 * Controlling a claude-loop remotely is a PRIVILEGED action: a malicious caller
 * could DoS an operator's loops (kill) or hijack an agent (inject an unfiltered
 * prompt). So it is gated to a local/direct **human moderator** and explicitly
 * DENIED to a **proxy node** token — a node token is the weak link (it may
 * assert any relayed `x-aiball-consumer`, including "human", see auth.ts /
 * docs/SECURITY.md), so trusting `isHuman` alone would let a compromised node
 * drive loops. Hence the two independent checks. Same gate for every control
 * action (kill / prompt) — both are equally sensitive.
 *
 * Pure (no Express / DB) so it unit-tests in isolation.
 */
export interface LoopControlVerdict {
    ok: boolean;
    reason?: string;
}

/**
 * May a caller drive a loop (kill it, inject a prompt, …)? `tokenKind` is the
 * request's auth tier (`agent` = UDS local-trust or a direct bearer; `node` = a
 * proxy node token). `callerIsHuman` is whether the resolved consumer is a
 * human/moderator.
 */
export function canControlLoop(
    tokenKind: string | undefined,
    callerIsHuman: boolean,
): LoopControlVerdict {
    if (tokenKind === "node") {
        return { ok: false, reason: "proxy nodes cannot control loops (anti-DoS — local/direct moderator only)" };
    }
    if (!callerIsHuman) {
        return { ok: false, reason: "loop control is moderator-only" };
    }
    return { ok: true };
}
