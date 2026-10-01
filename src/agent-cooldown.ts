/**
 * #3321 — how long a ticket rests in an agent's backlog after a backlog wake
 * named it: the loop's own setting (`CL_BACKLOG_COOLDOWN_SEC`), which it says
 * when it opens its events. Kept while the loop is present, like its presence:
 * `consumer.backlog` and the counters apply it when no `cooldown_sec` is
 * asked, so a client and the bar see the rest the loop really applies.
 */
import { onPresenceStop } from "./live-presence.js";
import { getConfig } from "./db/config-overrides.js";
import { getConsumer } from "./db/consumers.js";

/** The rest when neither the loop nor the config says one. */
export const DEFAULT_BACKLOG_COOLDOWN_SEC = 3600;

const said = new Map<string, number>();

/** The agent's loop says its rest, in seconds. */
export function setAgentCooldown(agent: string, sec: number): void {
    said.set(agent, sec);
}

/**
 * The rest `agent`'s backlog applies: what its loop said (CL_BACKLOG_COOLDOWN_SEC),
 * else #3472 `tickets.backlog.rest` for the agent's project, global as fallback.
 */
export function agentCooldownSec(agent: string): number {
    const loop = said.get(agent);
    if (loop !== undefined) return loop;
    const v = Number(getConfig("tickets.backlog.rest", getConsumer(agent)?.project ?? null));
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BACKLOG_COOLDOWN_SEC;
}

// A loop that is gone says nothing any more: the next one says its own.
onPresenceStop((agent) => said.delete(agent));

/** Tests only. */
export function resetAgentCooldownsForTests(): void {
    said.clear();
}
