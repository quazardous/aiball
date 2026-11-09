/**
 * #4874 — on the master's Nodes panel: whether a node may take the board over
 * now, and why not. The node says what it knows (its copy, its link to the
 * master) in the progress it pushes; the master adds what only it sees: the
 * other nodes connected to it, which a switch would leave without a master.
 */
export interface SwitchReadiness {
    ready: boolean;
    reasons: string[];
}

export function nodeSwitchState(
    replica: { switch?: SwitchReadiness | null } | null | undefined,
    connected: boolean,
    otherNodesConnected: number,
): SwitchReadiness {
    const reasons: string[] = [];
    if (!connected) reasons.push("the node is not connected");
    else if (!replica) reasons.push("the node keeps no copy of the board");
    else if (!replica.switch) reasons.push("the node does not say whether it can take over (update it)");
    else reasons.push(...replica.switch.reasons);
    if (otherNodesConnected > 0) {
        reasons.push(`${otherNodesConnected} other node${otherNodesConnected > 1 ? "s are" : " is"} connected to this master: they would lose it`);
    }
    return { ready: reasons.length === 0, reasons };
}

/** The gesture, made on the node itself. */
export const TAKE_COMMAND = "aiball master take --url <where this machine reaches the node>";
