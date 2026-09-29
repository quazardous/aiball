/**
 * #3321 — how long a ticket rests in an agent's backlog after a backlog wake
 * named it: the loop's own setting (`CL_BACKLOG_COOLDOWN_SEC`), which it says
 * when it opens its events. Kept while the loop is present, like its presence:
 * `consumer.backlog` and the counters apply it when no `cooldown_sec` is
 * asked, so a client and the bar see the rest the loop really applies.
 */
import { onPresenceStop } from "./live-presence.js";

/** The rest a loop applies when it says none: the loop's own default. */
export const DEFAULT_BACKLOG_COOLDOWN_SEC = 3600;

const said = new Map<string, number>();

/** The agent's loop says its rest, in seconds. */
export function setAgentCooldown(agent: string, sec: number): void {
    said.set(agent, sec);
}

/** The rest `agent`'s loop applies: what it said, else the default. */
export function agentCooldownSec(agent: string): number {
    return said.get(agent) ?? DEFAULT_BACKLOG_COOLDOWN_SEC;
}

// A loop that is gone says nothing any more: the next one says its own.
onPresenceStop((agent) => said.delete(agent));

/** Tests only. */
export function resetAgentCooldownsForTests(): void {
    said.clear();
}
