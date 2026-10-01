/**
 * #3340 — the clients attached to an agent's tmux loop, as its loop says
 * (`consumer.push_clients`): how many, and how many have the controls. The
 * loop reads `tmux list-clients` as it probes its session; the daemon keeps
 * the last word while the loop is present, and never runs tmux for it.
 */
import { onPresenceStop } from "../live-presence.js";

export interface TmuxClients {
    clients: number;
    /** #3477 — null when the multiplexer cannot say who has the controls (psmux). */
    interactive: number | null;
}

const said = new Map<string, TmuxClients>();

/** The loop says its clients; true when that changed what was known. */
export function setTmuxClients(agent: string, c: TmuxClients): boolean {
    const before = said.get(agent);
    said.set(agent, c);
    return !before || before.clients !== c.clients || before.interactive !== c.interactive;
}

/** What `agent`'s tmux loop last said, or null before it said anything. */
export function tmuxClientsOf(agent: string): TmuxClients | null {
    return said.get(agent) ?? null;
}

// A loop that is gone has no clients to tell of.
onPresenceStop((agent) => said.delete(agent));

/** Tests only. */
export function resetTmuxClientsForTests(): void {
    said.clear();
}
